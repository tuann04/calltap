import assert from "node:assert/strict";
import test from "node:test";
import worker from "./wake-worker.js";

function createMockBucket(initialObjects = {}) {
  const store = new Map();
  let seq = 1;

  for (const [key, val] of Object.entries(initialObjects)) {
    const bytes = typeof val === "string" ? new TextEncoder().encode(val) : new Uint8Array(val);
    store.set(key, { key, bytes, etag: `etag-${seq++}`, uploaded: new Date() });
  }

  return {
    store,
    async head(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { key: entry.key, size: entry.bytes.byteLength, etag: entry.etag, uploaded: entry.uploaded };
    },
    async get(key, opts) {
      const entry = store.get(key);
      if (!entry) return null;
      let slice = entry.bytes;
      if (opts?.range) {
        const offset = opts.range.offset || 0;
        const length = opts.range.length ?? entry.bytes.byteLength - offset;
        slice = entry.bytes.slice(offset, offset + length);
      }
      return {
        key: entry.key,
        size: entry.bytes.byteLength,
        etag: entry.etag,
        uploaded: entry.uploaded,
        body: new Blob([slice]).stream(),
        async json() {
          return JSON.parse(new TextDecoder().decode(slice));
        },
        async text() {
          return new TextDecoder().decode(slice);
        },
      };
    },
    async put(key, value) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      store.set(key, { key, bytes, etag: `etag-${seq++}`, uploaded: new Date() });
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
    async list({ prefix = "" } = {}) {
      const objects = [];
      for (const entry of store.values()) {
        if (entry.key.startsWith(prefix)) {
          objects.push({
            key: entry.key,
            size: entry.bytes.byteLength,
            etag: entry.etag,
            uploaded: entry.uploaded,
          });
        }
      }
      return { objects, truncated: false };
    },
  };
}

function makeEnv(bucket) {
  return {
    CALLS_BUCKET: bucket,
    R2_BUCKET_NAME: "calltap-calls",
    R2_PREFIX: "calls",
    NEKO_ORIGIN: "https://neko.example.com",
    CALLTAP_ORIGIN: "https://calltap.example.com",
    GRAFANA_ORIGIN: "https://grafana.example.com",
    WAKE_ORIGIN: "https://call.example.com",
    ASSETS: {
      async fetch(req) {
        return new Response(`SPA asset for ${new URL(req.url).pathname}`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    },
  };
}

test("serverless R2 dashboard serves SPA assets, status, calls, waveform, range audio, patch, and wake redirect when VM is sleeping", async () => {
  const callId = "20261114T120000Z-a1b2c3d4";
  const relDir = `2026/11/14/${callId}`;
  const sampleMeta = {
    call_id: callId,
    service: "sesame",
    title: "Morning check-in",
    notes: "Initial note",
    tags: ["ai", "daily"],
    favorite: false,
    started_at: "2026-11-14T12:00:00Z",
    ended_at: "2026-11-14T12:05:00Z",
    duration_seconds: 300,
    local_rel_dir: relDir,
    status: "completed",
    upload_status: "pending",
  };
  const samplePeaks = { version: 1, bins: 4, duration_seconds: 300, you: [0.1, 0.4, 0.2, 0.8], agent: [0.3, 0.5, 0.6, 0.2] };
  const sampleAudio = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const bucket = createMockBucket({
    [`calls/${relDir}/meta.json`]: JSON.stringify(sampleMeta),
    [`calls/${relDir}/peaks.json`]: JSON.stringify(samplePeaks),
    [`calls/${relDir}/mix.opus`]: sampleAudio,
  });
  const env = makeEnv(bucket);

  // Mock global fetch so origin VM returns 530 (sleeping Cloudflare Tunnel)
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Tunnel offline", { status: 530 });

  try {
    // 1. Root HTML serves SPA from ASSETS instead of redirecting to wake worker
    const rootRes = await worker.fetch(new Request("https://calltap.example.com/"), env);
    assert.equal(rootRes.status, 200);
    assert.match(await rootRes.text(), /SPA asset for \//);

    // 2. Explicit ?wake=1 redirects to wake worker
    const wakeRes = await worker.fetch(new Request("https://calltap.example.com/?wake=1"), env);
    assert.equal(wakeRes.status, 302);
    assert.equal(
      wakeRes.headers.get("location"),
      "https://call.example.com/?next=https%3A%2F%2Fcalltap.example.com&wait=1",
    );

    // 3. GET /api/status returns serverless sleeping status
    const statusRes = await worker.fetch(new Request("https://calltap.example.com/api/status"), env);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.vm_sleeping, true);
    assert.equal(statusJson.active_call, null);
    assert.equal(statusJson.wake_url, "https://call.example.com/?next=https%3A%2F%2Fcalltap.example.com&wait=1");

    // 4. GET /api/calls lists and normalizes call from R2
    const listRes = await worker.fetch(new Request("https://calltap.example.com/api/calls?q=Morning"), env);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.length, 1);
    assert.equal(listJson[0].call_id, callId);
    assert.equal(listJson[0].upload_status, "uploaded");

    // 5. GET /api/calls/:id/waveform serves peaks.json from R2
    const waveRes = await worker.fetch(
      new Request(`https://calltap.example.com/api/calls/${callId}/waveform`),
      env,
    );
    assert.equal(waveRes.status, 200);
    const waveJson = await waveRes.json();
    assert.deepEqual(waveJson.you, [0.1, 0.4, 0.2, 0.8]);

    // 6. GET /api/calls/:id/audio/mix with Range header returns 206 Partial Content
    const audioRes = await worker.fetch(
      new Request(`https://calltap.example.com/api/calls/${callId}/audio/mix`, {
        headers: { Range: "bytes=2-5" },
      }),
      env,
    );
    assert.equal(audioRes.status, 206);
    assert.equal(audioRes.headers.get("content-range"), "bytes 2-5/10");
    const audioSlice = new Uint8Array(await audioRes.arrayBuffer());
    assert.deepEqual(Array.from(audioSlice), [2, 3, 4, 5]);

    // 7. PATCH /api/calls/:id updates metadata in R2 and invalidates index
    const patchRes = await worker.fetch(
      new Request(`https://calltap.example.com/api/calls/${callId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Updated Title", favorite: true }),
      }),
      env,
    );
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.title, "Updated Title");
    assert.equal(patched.favorite, true);

    // 8. DELETE /api/calls/:id removes call objects from R2
    const delRes = await worker.fetch(
      new Request(`https://calltap.example.com/api/calls/${callId}`, { method: "DELETE" }),
      env,
    );
    assert.equal(delRes.status, 200);
    const afterDelList = await (
      await worker.fetch(new Request("https://calltap.example.com/api/calls"), env)
    ).json();
    assert.equal(afterDelList.length, 0);
    // 9. GET https://grafana.example.com/ redirects to wake worker when VM is asleep
    const grafWakeRes = await worker.fetch(new Request("https://grafana.example.com/"), env);
    assert.equal(grafWakeRes.status, 302);
    assert.equal(
      grafWakeRes.headers.get("location"),
      "https://call.example.com/?next=https%3A%2F%2Fgrafana.example.com%2F&wait=1",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
