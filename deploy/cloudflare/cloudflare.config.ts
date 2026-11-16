import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./wake-worker.js" with { type: "cf-worker" };

const nekoOrigin = process.env.NEKO_ORIGIN || "https://neko.tuann04.cloud";
const calltapOrigin = process.env.CALLTAP_ORIGIN || "https://calltap.tuann04.cloud";
const grafanaOrigin = process.env.GRAFANA_ORIGIN || "https://grafana.tuann04.cloud";
const wakeOrigin = process.env.WAKE_ORIGIN || "https://call.tuann04.cloud";
const wakeDomain = new URL(wakeOrigin).hostname;
const nekoDomain = new URL(nekoOrigin).hostname;
const calltapDomain = new URL(calltapOrigin).hostname;
const grafanaDomain = new URL(grafanaOrigin).hostname;
const vmName = process.env.AZURE_VM_NAME || "calltap-vm";
const r2Bucket = (process.env.R2_BUCKET_NAME || "").trim();
const r2Prefix = process.env.R2_PREFIX || "calls";
const kvNamespaceId = (process.env.KV_NAMESPACE_ID || "a76b15c391104d34a9c5f3cbf5bea9c3").trim();

export default defineConfig({
  worker: {
    name: "calltap-wake",
    compatibilityDate: "2026-11-01",
    entrypoint,
    assets: {
      runWorkerFirst: true,
      notFoundHandling: "single-page-application",
    },
    env: {
      ASSETS: bindings.assets(),
      ...(r2Bucket ? { CALLS_BUCKET: bindings.r2({ name: r2Bucket }) } : {}),
      ...(kvNamespaceId ? { CALLS_KV: bindings.kv({ id: kvNamespaceId }) } : {}),
      R2_BUCKET_NAME: bindings.text(r2Bucket || "calltap-calls"),
      R2_PREFIX: bindings.text(r2Prefix),
      NEKO_ORIGIN: bindings.text(nekoOrigin),
      CALLTAP_ORIGIN: bindings.text(calltapOrigin),
      GRAFANA_ORIGIN: bindings.text(grafanaOrigin),
      WAKE_ORIGIN: bindings.text(wakeOrigin),
      AZURE_CLIENT_ID: bindings.secret(),
      AZURE_CLIENT_SECRET: bindings.secret(),
      AZURE_TENANT_ID: bindings.secret(),
      AZURE_SUBSCRIPTION_ID: bindings.secret(),
      AZURE_RESOURCE_GROUP: bindings.secret(),
      AZURE_VM_NAME: bindings.text(vmName),
      SLEEP_SECRET: bindings.secret(),
    },
    triggers: [
      triggers.fetch({ pattern: `${wakeDomain}/*` }),
      triggers.fetch({ pattern: `${nekoDomain}/` }),
      triggers.fetch({ pattern: `${grafanaDomain}/` }),
      triggers.fetch({ pattern: `${calltapDomain}/*` }),
    ],
  },
});
