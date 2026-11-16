import { findCallMetaInR2, inferRelDirFromCallId, r2Prefix } from "./r2-store.js";

const TRACK_FILES = {
  you: "you.flac",
  agent: "agent.flac",
  mix: "mix.opus",
};

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
  const end = endStr ? Number.parseInt(endStr, 10) : totalSize - 1;
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end: Math.min(end, totalSize - 1) };
}

export async function tryServeR2Waveform(env, callId) {
  const bucket = env.CALLS_BUCKET;
  const kv = env.CALLS_KV;
  if (!bucket && !kv) return null;
  const relDir = inferRelDirFromCallId(callId) || (await findCallMetaInR2(env, callId))?.relDir;
  if (!relDir) return null;
  const key = `${r2Prefix(env)}/${relDir}/peaks.json`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, max-age=3600",
  };

  if (bucket) {
    const obj = await bucket.get(key);
    if (obj) return new Response(obj.body, { status: 200, headers });
  }
  if (kv) {
    const text = await kv.get(key, "text");
    if (text) return new Response(text, { status: 200, headers });
  }
  return null;
}

async function buildAudioResponse({
  request,
  totalSize,
  mediaType,
  download,
  meta,
  callId,
  fname,
  etag,
  getBody,
}) {
  const baseHeaders = new Headers({
    "Content-Type": mediaType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  });
  if (etag) {
    baseHeaders.set("ETag", etag);
  }
  if (download) {
    baseHeaders.set(
      "Content-Disposition",
      `attachment; filename="${downloadFilename(meta || { call_id: callId }, fname)}"`
    );
  }

  if (request.method === "HEAD") {
    baseHeaders.set("Content-Length", String(totalSize));
    return new Response(null, { status: 200, headers: baseHeaders });
  }

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, totalSize);
    if (!parsed) {
      baseHeaders.set("Content-Range", `bytes */${totalSize}`);
      return new Response("Requested Range Not Satisfiable", { status: 416, headers: baseHeaders });
    }
    const { start, end } = parsed;
    const length = end - start + 1;
    const body = await getBody({ start, end, length });
    if (!body) return null;
    baseHeaders.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    baseHeaders.set("Content-Length", String(length));
    return new Response(body, { status: 206, headers: baseHeaders });
  }

  const body = await getBody(null);
  if (!body) return null;
  baseHeaders.set("Content-Length", String(totalSize));
  return new Response(body, { status: 200, headers: baseHeaders });
}

export async function tryServeR2Audio(request, url, env, callId, track) {
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
      return buildAudioResponse({
        request,
        totalSize: head.size,
        mediaType,
        download,
        meta,
        callId,
        fname,
        etag: head.httpEtag,
        getBody: async (range) => {
          const obj = await bucket.get(
            key,
            range ? { range: { offset: range.start, length: range.length } } : undefined
          );
          return obj?.body ?? null;
        },
      });
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
      return buildAudioResponse({
        request,
        totalSize: bytes.byteLength,
        mediaType: effectiveMediaType,
        download,
        meta,
        callId,
        fname: effectiveFname,
        etag: null,
        getBody: async (range) => (range ? bytes.subarray(range.start, range.end + 1) : bytes),
      });
    }
  }

  return null;
}
