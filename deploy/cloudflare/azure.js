const AZURE_SCOPE = "https://management.azure.com/.default";
const BOOT_GRACE_MS = 35_000;

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function constantTimeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) {
    diff |= ha[i] ^ hb[i];
  }
  return diff === 0;
}

export async function getAzureToken(env) {
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

function vmResourceUrl(env, action) {
  return (
    `https://management.azure.com/subscriptions/${env.AZURE_SUBSCRIPTION_ID}` +
    `/resourceGroups/${env.AZURE_RESOURCE_GROUP}/providers/Microsoft.Compute` +
    `/virtualMachines/${env.AZURE_VM_NAME}/${action}?api-version=2024-03-01`
  );
}

export async function vmInstanceView(env, token) {
  const res = await fetch(vmResourceUrl(env, "instanceView"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`instanceView: ${res.status}`);
  const json = await res.json();
  const statuses = json.statuses || [];
  const power = statuses.map((s) => s.code).find((c) => c?.startsWith("PowerState")) || "unknown";
  const provTime = statuses.find((s) => s.code === "ProvisioningState/succeeded")?.time;
  const bootElapsedMs = provTime ? Math.max(0, Date.now() - Date.parse(provTime)) : Infinity;
  return { power, bootElapsedMs };
}

export function resolveTarget(env, nextParam) {
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

export function wakePage(target, refreshUrl, state, seconds) {
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

export async function handleWakeHost(request, url, env) {
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
    const res = await fetch(vmResourceUrl(env, "deallocate"), {
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
    return wakePage(target, refreshUrl.toString(), power, 5);
  }

  const res = await fetch(vmResourceUrl(env, "start"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 202) {
    return new Response(`Failed to start VM (HTTP ${res.status})`, { status: 502 });
  }
  return wakePage(target, refreshUrl.toString(), "VM starting", 10);
}
