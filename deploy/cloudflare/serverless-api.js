import { tryServeR2Audio, tryServeR2Waveform } from "./media-stream.js";
import {
  deleteCallFromR2,
  findCallMetaInR2,
  invalidateR2Index,
  loadCallsFromR2,
  r2BucketName,
  r2Prefix,
} from "./r2-store.js";

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

function matchesSearchQuery(call, q) {
  return (
    (call.title || "").toLowerCase().includes(q) ||
    (call.service || "").toLowerCase().includes(q) ||
    (call.call_id || "").toLowerCase().includes(q) ||
    (call.notes || "").toLowerCase().includes(q) ||
    (call.page_url || "").toLowerCase().includes(q) ||
    (call.page_title || "").toLowerCase().includes(q) ||
    (call.tags || []).some((t) => String(t).toLowerCase().includes(q))
  );
}

export async function handleServerlessApi(request, url, env) {
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
    const wakeUrl = new URL(env.WAKE_ORIGIN || url.origin);
    wakeUrl.searchParams.set("next", env.CALLTAP_ORIGIN || url.origin);
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
    if (service) items = items.filter((c) => c.service === service);
    if (uploadStatus) items = items.filter((c) => c.upload_status === uploadStatus);
    if (q) items = items.filter((c) => matchesSearchQuery(c, q));
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

  const editMatch = /^\/api\/calls\/([^/]+)\/edit$/.exec(pathname);
  if (editMatch && method === "POST") {
    return Response.json(
      { detail: "Audio editing needs the recorder VM. Click 'Wake VM' and try again." },
      { status: 409 }
    );
  }

  const waveformMatch = /^\/api\/calls\/([^/]+)\/waveform$/.exec(pathname);
  if (waveformMatch && method === "GET") {
    const res = await tryServeR2Waveform(env, decodeURIComponent(waveformMatch[1]));
    if (res) return res;
    return Response.json({ detail: "Waveform not found in R2" }, { status: 404 });
  }

  const audioMatch = /^\/api\/calls\/([^/]+)\/audio\/(you|agent|mix)$/.exec(pathname);
  if (audioMatch && (method === "GET" || method === "HEAD")) {
    const res = await tryServeR2Audio(
      request,
      url,
      env,
      decodeURIComponent(audioMatch[1]),
      audioMatch[2]
    );
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
