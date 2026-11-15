// Cloudflare Worker: 1-tap wake for CallTap on call.tuann04.cloud.
//
// GET  /         -> HTML landing page: boots the VM if needed, then links to Neko.
// GET  /status   -> JSON {vmState, booting}
// POST /sleep    -> deallocate the VM (called by the VM's idleness timer)
//
// Secrets (wrangler secret put):
//   AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID,
//   AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, AZURE_VM_NAME
// Vars (wrangler.toml):
//   NEKO_ORIGIN = "https://neko.tuann04.cloud"

const AZURE_SCOPE = "https://management.azure.com/.default";

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
  const code = json.statuses?.map((s) => s.code).find((c) => c?.startsWith("PowerState"));
  return code || "unknown";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      const token = await getAzureToken(env);
      const power = await vmInstanceView(env, token);
      return Response.json({ vmState: power, booting: power === "VM starting" });
    }

    if (url.pathname === "/sleep" && request.method === "POST") {
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

    const token = await getAzureToken(env);
    const power = await vmInstanceView(env, token);

    if (power === "VM running") {
      return Response.redirect(env.NEKO_ORIGIN, 302);
    }

    if (power !== "VM deallocated" && power !== "VM stopping") {
      // starting / unknown: refresh until running
      return wakePage(env, power, 5);
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
    return wakePage(env, "VM starting", 10);
  },
};

function wakePage(env, state, seconds) {
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
<meta http-equiv="refresh" content="${seconds}">
</head>
<body>
<main>
  <div class="spin"></div>
  <h1>Waking CallTap&hellip;</h1>
  <p>VM state: ${state}</p>
  <p>Takes about 30&ndash;45 seconds. This page refreshes every ${seconds}s.</p>
  <p><a href="${env.NEKO_ORIGIN}">Open Neko now</a></p>
</main>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
