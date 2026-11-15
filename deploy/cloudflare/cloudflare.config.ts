import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./wake-worker.js" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "calltap-wake",
    compatibilityDate: "2026-11-01",
    entrypoint,
    env: {
      NEKO_ORIGIN: bindings.text("https://neko.tuann04.cloud"),
      AZURE_CLIENT_ID: bindings.secret(),
      AZURE_CLIENT_SECRET: bindings.secret(),
      AZURE_TENANT_ID: bindings.secret(),
      AZURE_SUBSCRIPTION_ID: bindings.secret(),
      AZURE_RESOURCE_GROUP: bindings.secret(),
      AZURE_VM_NAME: bindings.text("calltap-vm"),
    },
    triggers: [triggers.fetch({ pattern: "call.tuann04.cloud/*" })],
  },
});
