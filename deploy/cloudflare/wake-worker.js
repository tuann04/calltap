// Cloudflare Worker: Hybrid Serverless Dashboard (R2 + Static Assets) + 1-tap Wake

import { handleWakeHost } from "./azure.js";
import { tryServeR2Audio, tryServeR2Waveform } from "./media-stream.js";
import { invalidateR2Index } from "./r2-store.js";
import { handleServerlessApi } from "./serverless-api.js";

const TUNNEL_DOWN_STATUSES = new Set([502, 503, 521, 522, 523, 530]);

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
    return handleWakeHost(request, url, env);
  },
};
