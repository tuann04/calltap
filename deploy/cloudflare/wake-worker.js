// Cloudflare Worker: Hybrid Serverless Dashboard (R2 + Static Assets) + 1-tap Wake
//
// Routes:
// 1. call.example.com/*:
//    - GET  /         -> HTML landing page: boots the Azure VM + waits for tunnel, then redirects to ?next=
//    - GET  /status   -> JSON {vmState, booting}
//    - POST /sleep    -> deallocate the VM (requires Authorization: Bearer <SLEEP_SECRET>)
//
// 2. neko.example.com/:
//    - Passes through to Tunnel when awake; redirects (302) to call.example.com/?next=...&wait=1 when asleep.
//
// 3. calltap.example.com/*:
//    - GET /?wake=1   -> redirects (302) to call.example.com/?next=...&wait=1 to wake the Recorder VM on demand.
//    - GET /api/calls/:id/waveform & /api/calls/:id/audio/:track -> serves directly from R2 (CALLS_BUCKET)
//      at the edge when available (with HTTP Range 206 support), falling back to the VM origin for un-uploaded calls.
//    - When VM is awake: proxies live recorder API & UI requests to the VM (and mirrors metadata edits/deletes to R2 index).
//    - When VM is asleep (530/502/503/521-523): serves the React SPA from Worker Static Assets (env.ASSETS)
//      and serves /api/* (list, search, waveform, audio streaming, rename/notes/tags PATCH, delete) directly from R2
//      with 0ms cold start and $0/hr VM compute.

const AZURE_SCOPE = "https://management.azure.com/.default";
const BOOT_GRACE_MS = 35_000;
const TUNNEL_DOWN_STATUSES = new Set([502, 503, 521, 522, 523, 530]);
const TRACK_FILES = {
  you: "you.flac",
  agent: "agent.flac",
  mix: "mix.opus",
};

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function constantTimeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) {
    diff |= ha[i] ^ hb[i];
  }
  return diff === 0;
}

async function getAzureToken(env) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.AZURE_CLIENT_ID,
    client_secret: env.AZURE_CLIENT_SECRET,
    scope: AZURE_SCOPE,
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", body }
  );
  if (!res.ok) throw new Error(`azure token: ${res.status}`);
  const json = await res.json();
  return json.access_token;
}

async function vmInstanceView(env, token) {
  const url =
    `https://management.azure.com/subscriptions/${env.AZURE_SUBSCRIPTION_ID}` +
    `/resourceGroups/${env.AZURE_RESOURCE_GROUP}/providers/Microsoft.Compute` +
    `/virtualMachines/${env.AZURE_VM_NAME}/instanceView?api-version=2024-03-01`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`instanceView: ${res.status}`);
  const json = await res.json();
  const statuses = json.statuses || [];
  const power = statuses.map((s) => s.code).find((c) => c?.startsWith("PowerState")) || "unknown";
  const provTime = statuses.find((s) => s.code === "ProvisioningState/succeeded")?.time;
  const bootElapsedMs = provTime ? Math.max(0, Date.now() - Date.parse(provTime)) : Infinity;
  return { power, bootElapsedMs };
}

function resolveTarget(env, nextParam) {
  if (nextParam) {
    try {
      const parsed = new URL(nextParam);
      const allowed = [env.NEKO_ORIGIN, env.CALLTAP_ORIGIN, env.GRAFANA_ORIGIN].filter(Boolean);
      if (allowed.some((origin) => parsed.origin === new URL(origin).origin)) {
        return parsed.toString();
      }
    } catch {}
  }
  return env.NEKO_ORIGIN;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function r2Prefix(env) {
  return (env.R2_PREFIX || "calls").replace(/^\/+|\/+$/g, "") || "calls";
}

function r2BucketName(env) {
  return env.R2_BUCKET_NAME || "calltap-calls";
}

function inferRelDirFromCallId(callId) {
  const m = /^(\d{4})(\d{2})(\d{2})T\d{6}Z-[a-zA-Z0-9_-]+$/.exec(callId);
  if (!m) return null;
  return `${m[1]}/${m[2]}/${m[3]}/${callId}`;
}

function normalizeCallMeta(raw, env) {
  const bucket = r2BucketName(env);
  const prefix = r2Prefix(env);
  const relDir = raw.local_rel_dir || inferRelDirFromCallId(raw.call_id) || raw.call_id;
  return {
    call_id: raw.call_id,
    title: raw.title ?? "",
    service: raw.service ?? "unknown",
    trigger: raw.trigger ?? "auto",
    page_url: raw.page_url ?? null,
    page_title: raw.page_title ?? null,
    started_at: raw.started_at,
    ended_at: raw.ended_at ?? null,
    duration_seconds: raw.duration_seconds ?? null,
    sample_rate: raw.sample_rate ?? 48000,
    files: raw.files ?? { you: "you.flac", agent: "agent.flac", mix: "mix.opus" },
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    notes: raw.notes ?? "",
    local_rel_dir: relDir,
    status: raw.status === "recording" || raw.status === "finalizing" ? "completed" : (raw.status ?? "completed"),
    upload_status: "uploaded",
    upload_attempts: raw.upload_attempts ?? 1,
    upload_error: null,
    remote_uri: raw.remote_uri || `r2:${bucket}/${prefix}/${relDir}`,
    uploaded_at: raw.uploaded_at || raw.ended_at || raw.started_at,
    local_pruned: Boolean(raw.local_pruned),
  };
}

function downloadFilename(meta, fname) {
  let base = (meta?.title || "").trim();
  if (!base) {
    let label = meta?.service || "call";
    if ((label === "unknown" || label === "generic" || !label) && meta?.page_url) {
      try {
        const host = new URL(meta.page_url).hostname.toLowerCase().replace(/^www\./, "");
        if (host) label = host;
      } catch {}
    }
    const d = meta?.started_at ? new Date(meta.started_at) : null;
    if (d && !Number.isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
      base = `${label}-${stamp}`;
    } else {
      base = meta?.call_id || "call";
    }
  }
  const slug =
    base
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .toLowerCase()
      .slice(0, 80) ||
    meta?.call_id ||
    "call";
  return `${slug}-${fname}`;
}

async function listAllMetaObjects(bucket, prefix) {
  const metaObjs = [];
  let cursor = undefined;
  do {
    const listed = await bucket.list({ prefix: `${prefix}/`, cursor, limit: 1000 });
    for (const obj of listed.objects || []) {
      if (obj.key.endsWith("/meta.json")) {
        metaObjs.push(obj);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return metaObjs;
}

async function loadCallsFromKV(env) {
  const kv = env.CALLS_KV;
  if (!kv) return [];
  const prefix = r2Prefix(env);
  const indexRaw = await kv.get(`${prefix}/index.json`, "json");
  if (indexRaw && Array.isArray(indexRaw.calls)) {
    return indexRaw.calls.map((c) => normalizeCallMeta(c, env));
  }
  const listed = await kv.list({ prefix: `${prefix}/` });
  const metaKeys = (listed.keys || []).filter((k) => k.name.endsWith("/meta.json"));
  const calls = [];
  for (const k of metaKeys) {
    try {
      const raw = await kv.get(k.name, "json");
      if (raw && raw.call_id) calls.push(normalizeCallMeta(raw, env));
    } catch {}
  }
  calls.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
  return calls;
}

async function loadCallsFromR2(env) {
  const bucket = env.CALLS_BUCKET;
  if (!bucket) return loadCallsFromKV(env);
  const prefix = r2Prefix(env);
  const indexKey = `${prefix}/index.json`;

  const [metaObjs, indexObj] = await Promise.all([
    listAllMetaObjects(bucket, prefix),
    bucket.get(indexKey),
  ]);

  let cachedEntries = {};
  if (indexObj) {
    try {
      const parsed = await indexObj.json();
      if (parsed && typeof parsed.entries === "object" && parsed.entries !== null) {
        cachedEntries = parsed.entries;
      }
    } catch {}
  }

  let dirty = false;
  const nextEntries = {};
  const seenKeys = new Set();

  await Promise.all(
    metaObjs.map(async (obj) => {
      seenKeys.add(obj.key);
      const etag = obj.etag || obj.httpEtag || String(obj.size);
      const cached = cachedEntries[obj.key];
      if (cached && cached.etag === etag && cached.meta) {
        nextEntries[obj.key] = cached;
        return;
      }
      dirty = true;
      try {
        const body = await bucket.get(obj.key);
        if (!body) return;
        const raw = await body.json();
        if (raw && raw.call_id) {
          nextEntries[obj.key] = {
            etag,
            meta: normalizeCallMeta(raw, env),
          };
        }
      } catch {}
    })
  );

  for (const oldKey of Object.keys(cachedEntries)) {
    if (!seenKeys.has(oldKey)) {
      dirty = true;
    }
  }

  if (dirty) {
    try {
      await bucket.put(indexKey, JSON.stringify({ updated_at: new Date().toISOString(), entries: nextEntries }), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch {}
  }

  const calls = Object.values(nextEntries).map((e) => e.meta);
  calls.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
  return calls;
}

async function findCallMetaInR2(env, callId) {
  const bucket = env.CALLS_BUCKET;
  const kv = env.CALLS_KV;
  const prefix = r2Prefix(env);
  const inferredRel = inferRelDirFromCallId(callId);
  if (inferredRel) {
    const metaKey = `${prefix}/${inferredRel}/meta.json`;
    if (bucket) {
      const obj = await bucket.get(metaKey);
      if (obj) {
        try {
          const raw = await obj.json();
          return { meta: normalizeCallMeta(raw, env), relDir: inferredRel, metaKey, store: "r2" };
        } catch {}
      }
    }
    if (kv) {
      const raw = await kv.get(metaKey, "json");
      if (raw) {
        return { meta: normalizeCallMeta(raw, env), relDir: inferredRel, metaKey, store: "kv" };
      }
    }
  }

  const calls = await loadCallsFromR2(env);
  const found = calls.find((c) => c.call_id === callId);
  if (!found) return null;
  const relDir = found.local_rel_dir;
  return { meta: found, relDir, metaKey: `${prefix}/${relDir}/meta.json`, store: bucket ? "r2" : "kv" };
}

async function invalidateR2Index(env) {
  const prefix = r2Prefix(env);
  if (env.CALLS_BUCKET) {
    try {
      await env.CALLS_BUCKET.delete(`${prefix}/index.json`);
    } catch {}
  }
  if (env.CALLS_KV) {
    try {
      await env.CALLS_KV.delete(`${prefix}/index.json`);
    } catch {}
  }
}

async function deleteCallFromR2(env, callId) {
  const found = await findCallMetaInR2(env, callId);
  if (!found) return false;
  const prefix = r2Prefix(env);
  const dirPrefix = `${prefix}/${found.relDir}/`;
  if (env.CALLS_BUCKET) {
    const listed = await env.CALLS_BUCKET.list({ prefix: dirPrefix });
    const keys = (listed.objects || []).map((o) => o.key);
    if (keys.length > 0) {
      await env.CALLS_BUCKET.delete(keys);
    }
  }
  if (env.CALLS_KV) {
    const listed = await env.CALLS_KV.list({ prefix: dirPrefix });
    for (const k of listed.keys || []) {
      await env.CALLS_KV.delete(k.name);
    }
  }
  return true;
}

function parseByteRange(rangeHeader, totalSize) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) return null;
  const spec = rangeHeader.slice("bytes=".length).trim().split(",")[0].trim();
  const [startStr, endStr] = spec.split("-");
  if (startStr === "" && endStr) {
    const suffixLen = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null;
    const start = Math.max(0, totalSize - suffixLen);
    return { start, end: totalSize - 1 };
  }
  const start = Number.parseInt(startStr, 10);
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) return null;
  let end = endStr ? Number.parseInt(endStr, 10) : totalSize - 1;
  if (!Number.isFinite(end) || end < start) return null;
  end = Math.min(end, totalSize - 1);
  return { start, end };
}

async function tryServeR2Waveform(env, callId) {
  const bucket = env.CALLS_BUCKET;
  const kv = env.CALLS_KV;
  if (!bucket && !kv) return null;
  const prefix = r2Prefix(env);
  const relDir = inferRelDirFromCallId(callId) || (await findCallMetaInR2(env, callId))?.relDir;
  if (!relDir) return null;
  const key = `${prefix}/${relDir}/peaks.json`;
  if (bucket) {
    const obj = await bucket.get(key);
    if (obj) {
      return new Response(obj.body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
  }
  if (kv) {
    const text = await kv.get(key, "text");
    if (text) {
      return new Response(text, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
  }
  return null;
}

async function tryServeR2Audio(request, url, env, callId, track) {
  const bucket = env.CALLS_BUCKET;
  const kv = env.CALLS_KV;
  if (!bucket && !kv) return null;
  const defaultFile = TRACK_FILES[track];
  if (!defaultFile) return null;

  const prefix = r2Prefix(env);
  const download = url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";
  let relDir = inferRelDirFromCallId(callId);
  let meta = null;
  if (!relDir || download) {
    const found = await findCallMetaInR2(env, callId);
    if (found) {
      relDir = found.relDir;
      meta = found.meta;
    }
  }
  if (!relDir) return null;

  const fname = (meta?.files && meta.files[track]) || defaultFile;
  const key = `${prefix}/${relDir}/${fname}`;
  const mediaType = fname.endsWith(".opus") ? "audio/ogg" : "audio/flac";

  if (bucket) {
    const head = await bucket.head(key);
    if (head) {
      const totalSize = head.size;
      const baseHeaders = new Headers({
        "Content-Type": mediaType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      });
      if (head.httpEtag) {
        baseHeaders.set("ETag", head.httpEtag);
      }
      if (download) {
        const dlName = downloadFilename(meta || { call_id: callId }, fname);
        baseHeaders.set("Content-Disposition", `attachment; filename="${dlName}"`);
      }

      if (request.method === "HEAD") {
        baseHeaders.set("Content-Length", String(totalSize));
        return new Response(null, { status: 200, headers: baseHeaders });
      }

      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        const parsedRange = parseByteRange(rangeHeader, totalSize);
        if (!parsedRange) {
          baseHeaders.set("Content-Range", `bytes */${totalSize}`);
          return new Response("Requested Range Not Satisfiable", { status: 416, headers: baseHeaders });
        }
        const { start, end } = parsedRange;
        const length = end - start + 1;
        const rangedObj = await bucket.get(key, { range: { offset: start, length } });
        if (!rangedObj) return null;
        baseHeaders.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        baseHeaders.set("Content-Length", String(length));
        return new Response(rangedObj.body, { status: 206, headers: baseHeaders });
      }

      const fullObj = await bucket.get(key);
      if (!fullObj) return null;
      baseHeaders.set("Content-Length", String(totalSize));
      return new Response(fullObj.body, { status: 200, headers: baseHeaders });
    }
  }

  // Fallback to CALLS_KV (supports mix.opus directly or chunked audio)
  if (kv) {
    let kvKey = key;
    let buf = await kv.get(kvKey, "arrayBuffer");
    let effectiveMediaType = mediaType;
    let effectiveFname = fname;
    if (!buf && track !== "mix") {
      // If individual FLAC exceeded KV 25 MiB limit, fall back to mix.opus in KV
      kvKey = `${prefix}/${relDir}/mix.opus`;
      buf = await kv.get(kvKey, "arrayBuffer");
      effectiveMediaType = "audio/ogg";
      effectiveFname = "mix.opus";
    }
    if (buf) {
      const bytes = new Uint8Array(buf);
      const totalSize = bytes.byteLength;
      const baseHeaders = new Headers({
        "Content-Type": effectiveMediaType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      });
      if (download) {
        const dlName = downloadFilename(meta || { call_id: callId }, effectiveFname);
        baseHeaders.set("Content-Disposition", `attachment; filename="${dlName}"`);
      }
      if (request.method === "HEAD") {
        baseHeaders.set("Content-Length", String(totalSize));
        return new Response(null, { status: 200, headers: baseHeaders });
      }
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        const parsedRange = parseByteRange(rangeHeader, totalSize);
        if (!parsedRange) {
          baseHeaders.set("Content-Range", `bytes */${totalSize}`);
          return new Response("Requested Range Not Satisfiable", { status: 416, headers: baseHeaders });
        }
        const { start, end } = parsedRange;
        const slice = bytes.subarray(start, end + 1);
        baseHeaders.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        baseHeaders.set("Content-Length", String(slice.byteLength));
        return new Response(slice, { status: 206, headers: baseHeaders });
      }
      baseHeaders.set("Content-Length", String(totalSize));
      return new Response(bytes, { status: 200, headers: baseHeaders });
    }
  }

  return null;
}

function buildServerlessStorageView(env) {
  const bucket = r2BucketName(env);
  const prefix = r2Prefix(env);
  const connected = Boolean(env.CALLS_BUCKET || env.CALLS_KV);
  return {
    connected,
    source: connected ? "env" : "none",
    provider: env.CALLS_BUCKET ? "r2" : env.CALLS_KV ? "cf-kv" : "none",
    auto_upload: true,
    bucket: connected ? bucket : "",
    prefix,
    endpoint: "",
    region: "auto",
    access_key_id: "",
    has_secret: connected,
    secret_hint: "",
    has_gdrive_token: false,
    gdrive_client_id: "",
    gdrive_root_folder_id: "",
    remote_label: env.CALLS_BUCKET ? `r2:${bucket}` : env.CALLS_KV ? "cloudflare:kv" : "Local storage only",
  };
}

async function handleServerlessApi(request, url, env) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/healthz") {
    return Response.json({ status: "ok", mode: "serverless" });
  }

  if (pathname === "/api/telemetry" && method === "POST") {
    return Response.json({ accepted: 1 });
  }

  if (pathname === "/api/status" && method === "GET") {
    const storage = buildServerlessStorageView(env);
    const wakeOrigin = env.WAKE_ORIGIN || url.origin;
    const calltapOrigin = env.CALLTAP_ORIGIN || url.origin;
    const wakeUrl = new URL(wakeOrigin);
    wakeUrl.searchParams.set("next", calltapOrigin);
    wakeUrl.searchParams.set("wait", "1");

    return Response.json({
      active_call: null,
      auto_detect: true,
      pulse_healthy: false,
      rclone_remote: storage.connected ? storage.remote_label : null,
      storage,
      pending_uploads: 0,
      active_tab: { service: "unknown", url: null, title: null },
      vm_sleeping: true,
      wake_url: wakeUrl.toString(),
      neko_url: env.NEKO_ORIGIN || null,
    });
  }

  if (pathname === "/api/storage" && method === "GET") {
    return Response.json(buildServerlessStorageView(env));
  }

  if (pathname === "/api/calls" && method === "GET") {
    const limit = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100));
    const service = url.searchParams.get("service");
    const uploadStatus = url.searchParams.get("upload_status");
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();

    let items = await loadCallsFromR2(env);
    if (service) {
      items = items.filter((c) => c.service === service);
    }
    if (uploadStatus) {
      items = items.filter((c) => c.upload_status === uploadStatus);
    }
    if (q) {
      items = items.filter(
        (c) =>
          (c.title || "").toLowerCase().includes(q) ||
          (c.service || "").toLowerCase().includes(q) ||
          (c.call_id || "").toLowerCase().includes(q) ||
          (c.notes || "").toLowerCase().includes(q) ||
          (c.page_url || "").toLowerCase().includes(q) ||
          (c.page_title || "").toLowerCase().includes(q) ||
          (c.tags || []).some((t) => String(t).toLowerCase().includes(q))
      );
    }
    return Response.json(items.slice(0, limit));
  }

  if (pathname === "/api/calls/bulk-delete" && method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const callIds = Array.isArray(body?.call_ids) ? body.call_ids : [];
    const deleted = [];
    for (const cid of callIds) {
      if (await deleteCallFromR2(env, String(cid))) {
        deleted.push(String(cid));
      }
    }
    if (deleted.length > 0) {
      await invalidateR2Index(env);
    }
    return Response.json({ deleted: deleted.length, call_ids: deleted });
  }

  if (
    pathname === "/api/calls/start" ||
    pathname === "/api/calls/stop" ||
    pathname === "/api/auto-detect" ||
    pathname === "/api/calls/bulk-upload"
  ) {
    return Response.json(
      { detail: "Recorder VM is currently sleeping ($0/hr). Click 'Wake VM to Record' to start a live session." },
      { status: 409 }
    );
  }

  const waveformMatch = /^\/api\/calls\/([^/]+)\/waveform$/.exec(pathname);
  if (waveformMatch && method === "GET") {
    const callId = decodeURIComponent(waveformMatch[1]);
    const res = await tryServeR2Waveform(env, callId);
    if (res) return res;
    return Response.json({ detail: "Waveform not found in R2" }, { status: 404 });
  }

  const audioMatch = /^\/api\/calls\/([^/]+)\/audio\/(you|agent|mix)$/.exec(pathname);
  if (audioMatch && (method === "GET" || method === "HEAD")) {
    const callId = decodeURIComponent(audioMatch[1]);
    const track = audioMatch[2];
    const res = await tryServeR2Audio(request, url, env, callId, track);
    if (res) return res;
    return Response.json({ detail: "Audio track not found in R2" }, { status: 404 });
  }

  const callItemMatch = /^\/api\/calls\/([^/]+)$/.exec(pathname);
  if (callItemMatch) {
    const callId = decodeURIComponent(callItemMatch[1]);
    if (method === "GET") {
      const found = await findCallMetaInR2(env, callId);
      if (!found) return Response.json({ detail: "Call not found" }, { status: 404 });
      return Response.json(found.meta);
    }

    if (method === "PATCH") {
      const found = await findCallMetaInR2(env, callId);
      if (!found) return Response.json({ detail: "Call not found" }, { status: 404 });
      let patch = {};
      try {
        patch = await request.json();
      } catch {}
      const updated = { ...found.meta };
      if (typeof patch.title === "string") updated.title = patch.title.trim();
      if (typeof patch.service === "string" && patch.service.trim()) updated.service = patch.service.trim();
      if (Array.isArray(patch.tags)) updated.tags = patch.tags;
      if (typeof patch.notes === "string") updated.notes = patch.notes;
      if (typeof patch.favorite === "boolean") updated.favorite = patch.favorite;

      const serialized = `${JSON.stringify(updated, null, 2)}\n`;
      if (env.CALLS_BUCKET) {
        await env.CALLS_BUCKET.put(found.metaKey, serialized, {
          httpMetadata: { contentType: "application/json" },
        });
      }
      if (env.CALLS_KV) {
        await env.CALLS_KV.put(found.metaKey, serialized);
      }
      await invalidateR2Index(env);
      return Response.json(updated);
    }

    if (method === "DELETE") {
      const ok = await deleteCallFromR2(env, callId);
      if (!ok) return Response.json({ detail: "Call not found" }, { status: 404 });
      await invalidateR2Index(env);
      return Response.json({ deleted: true, call_id: callId });
    }
  }

  return Response.json({ detail: "Endpoint unavailable while Recorder VM is sleeping" }, { status: 404 });
}

async function handleCalltapHost(request, url, env) {
  const wakeOrigin = env.WAKE_ORIGIN || url.origin;
  const calltapOrigin = env.CALLTAP_ORIGIN || url.origin;

  // Explicit 1-tap wake request from the serverless dashboard
  if (url.pathname === "/" && url.searchParams.get("wake") === "1") {
    const wakeUrl = new URL(wakeOrigin);
    wakeUrl.searchParams.set("next", calltapOrigin);
    wakeUrl.searchParams.set("wait", "1");
    return Response.redirect(wakeUrl.toString(), 302);
  }

  // Edge R2/KV fast-path for audio & waveforms (serves synced/pruned calls directly from edge even when VM is awake)
  const waveformMatch = /^\/api\/calls\/([^/]+)\/waveform$/.exec(url.pathname);
  if (waveformMatch && request.method === "GET" && (env.CALLS_BUCKET || env.CALLS_KV)) {
    const r2Wave = await tryServeR2Waveform(env, decodeURIComponent(waveformMatch[1]));
    if (r2Wave) return r2Wave;
  }

  const audioMatch = /^\/api\/calls\/([^/]+)\/audio\/(you|agent|mix)$/.exec(url.pathname);
  if (audioMatch && (request.method === "GET" || request.method === "HEAD") && (env.CALLS_BUCKET || env.CALLS_KV)) {
    const r2Audio = await tryServeR2Audio(
      request,
      url,
      env,
      decodeURIComponent(audioMatch[1]),
      audioMatch[2]
    );
    if (r2Audio) return r2Audio;
  }

  // Try forwarding to the VM tunnel origin (clone request so body remains readable if tunnel is sleeping)
  try {
    const res = await fetch(request.clone());
    if (!TUNNEL_DOWN_STATUSES.has(res.status)) {
      if (
        res.ok &&
        (env.CALLS_BUCKET || env.CALLS_KV) &&
        (request.method === "PATCH" || request.method === "DELETE" || url.pathname === "/api/calls/bulk-delete")
      ) {
        await invalidateR2Index(env);
      }
      return res;
    }
  } catch {
    // Tunnel unreachable -> fall through to serverless R2 + static assets mode.
  }

  // VM is asleep: serve API from R2 and SPA from Worker Static Assets
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
    return handleServerlessApi(request, url, env);
  }

  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }

  return new Response("CallTap serverless assets not bound", { status: 503 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wakeOrigin = env.WAKE_ORIGIN || url.origin;
    const wakeHost = new URL(wakeOrigin).hostname;
    const nekoHost = env.NEKO_ORIGIN ? new URL(env.NEKO_ORIGIN).hostname : null;
    const grafanaHost = env.GRAFANA_ORIGIN ? new URL(env.GRAFANA_ORIGIN).hostname : null;

    // 1. Neko remote browser & Grafana: pass through when awake; redirect to wake page when asleep.
    if ((nekoHost && url.hostname === nekoHost) || (grafanaHost && url.hostname === grafanaHost)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return fetch(request);
      }
      try {
        const res = await fetch(request);
        if (!TUNNEL_DOWN_STATUSES.has(res.status)) {
          return res;
        }
      } catch {
        // Tunnel / origin unreachable -> fall through to wake redirect.
      }
      const wakeUrl = new URL(wakeOrigin);
      wakeUrl.searchParams.set("next", request.url);
      wakeUrl.searchParams.set("wait", "1");
      return Response.redirect(wakeUrl.toString(), 302);
    }

    // 2. CallTap dashboard: hybrid serverless mode (R2 + edge assets when asleep, VM proxy when awake).
    if (url.hostname !== wakeHost) {
      return handleCalltapHost(request, url, env);
    }

    // 3. Wake Worker (call.example.com)
    if (url.pathname === "/status") {
      const token = await getAzureToken(env);
      const { power } = await vmInstanceView(env, token);
      return Response.json({ vmState: power, booting: power === "PowerState/starting" });
    }

    if (url.pathname === "/sleep" && request.method === "POST") {
      if (!env.SLEEP_SECRET) {
        return new Response("SLEEP_SECRET not configured", { status: 503 });
      }
      const auth = request.headers.get("Authorization") || "";
      if (!(await constantTimeEqual(auth, `Bearer ${env.SLEEP_SECRET}`))) {
        return new Response("Unauthorized", { status: 401 });
      }

      const token = await getAzureToken(env);
      const deallocate =
        `https://management.azure.com/subscriptions/${env.AZURE_SUBSCRIPTION_ID}` +
        `/resourceGroups/${env.AZURE_RESOURCE_GROUP}/providers/Microsoft.Compute` +
        `/virtualMachines/${env.AZURE_VM_NAME}/deallocate?api-version=2024-03-01`;
      const res = await fetch(deallocate, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      // 202 = deallocation accepted; VM finishes current work then powers off.
      return Response.json({ ok: res.ok || res.status === 202, status: res.status });
    }

    if (url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    const target = resolveTarget(env, url.searchParams.get("next"));
    const refreshUrl = new URL(url.origin);
    if (url.searchParams.get("next")) {
      refreshUrl.searchParams.set("next", target);
    }

    const token = await getAzureToken(env);
    const { power, bootElapsedMs } = await vmInstanceView(env, token);
    const short = power.replace("PowerState/", "");

    if (short === "running") {
      if (url.searchParams.get("wait") === "1") {
        return wakePage(target, refreshUrl.toString(), "Waiting for tunnel...", 5);
      }
      if (bootElapsedMs < BOOT_GRACE_MS) {
        return wakePage(target, refreshUrl.toString(), "Starting containers & tunnel...", 5);
      }
      return Response.redirect(target, 302);
    }

    if (short !== "deallocated" && short !== "stopping") {
      // starting / unknown: refresh until running
      return wakePage(target, refreshUrl.toString(), power, 5);
    }

    const start =
      `https://management.azure.com/subscriptions/${env.AZURE_SUBSCRIPTION_ID}` +
      `/resourceGroups/${env.AZURE_RESOURCE_GROUP}/providers/Microsoft.Compute` +
      `/virtualMachines/${env.AZURE_VM_NAME}/start?api-version=2024-03-01`;
    const res = await fetch(start, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok && res.status !== 202) {
      return new Response(`Failed to start VM (HTTP ${res.status})`, { status: 502 });
    }
    return wakePage(target, refreshUrl.toString(), "VM starting", 10);
  },
};

function wakePage(target, refreshUrl, state, seconds) {
  const safeTarget = escapeHtml(target);
  const safeRefresh = escapeHtml(refreshUrl);
  const safeState = escapeHtml(state);
  const targetHost = escapeHtml(new URL(target).hostname);
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CallTap is waking up</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex;
         min-height: 100vh; align-items: center; justify-content: center;
         background: #0b0f14; color: #e6edf3; margin: 0; }
  main { text-align: center; padding: 2rem; }
  .spin { width: 44px; height: 44px; border: 4px solid #2d333b;
          border-top-color: #58a6ff; border-radius: 50%;
          animation: spin 1s linear infinite; margin: 0 auto 1.2rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { color: #8b949e; margin: 0.4rem 0; }
  a { color: #58a6ff; }
</style>
<meta http-equiv="refresh" content="${seconds};url=${safeRefresh}">
</head>
<body>
<main>
  <div class="spin"></div>
  <h1>Waking CallTap&hellip;</h1>
  <p>VM state: ${safeState}</p>
  <p>Takes about 35&ndash;45 seconds. This page refreshes every ${seconds}s.</p>
  <p><a href="${safeTarget}">Open ${targetHost} now</a></p>
</main>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
