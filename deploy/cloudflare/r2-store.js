export function r2Prefix(env) {
  return (env.R2_PREFIX || "calls").replace(/^\/+|\/+$/g, "") || "calls";
}

export function r2BucketName(env) {
  return env.R2_BUCKET_NAME || "calltap-calls";
}

export function inferRelDirFromCallId(callId) {
  const m = /^(\d{4})(\d{2})(\d{2})T\d{6}Z-[a-zA-Z0-9_-]+$/.exec(callId);
  if (!m) return null;
  return `${m[1]}/${m[2]}/${m[3]}/${callId}`;
}

export function normalizeCallMeta(raw, env) {
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

async function listAllMetaObjects(bucket, prefix) {
  const metaObjs = [];
  let cursor;
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

export async function loadCallsFromR2(env) {
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
      await bucket.put(
        indexKey,
        JSON.stringify({ updated_at: new Date().toISOString(), entries: nextEntries }),
        { httpMetadata: { contentType: "application/json" } }
      );
    } catch {}
  }

  const calls = Object.values(nextEntries).map((e) => e.meta);
  calls.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
  return calls;
}

export async function findCallMetaInR2(env, callId) {
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

export async function invalidateR2Index(env) {
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

export async function deleteCallFromR2(env, callId) {
  const found = await findCallMetaInR2(env, callId);
  if (!found) return false;
  const dirPrefix = `${r2Prefix(env)}/${found.relDir}/`;
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
