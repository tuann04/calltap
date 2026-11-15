import React, { useEffect, useState } from "react";
import { CheckCircle2, Cloud, CloudOff, HardDrive, Loader2, X, XCircle } from "lucide-react";
import { api } from "../api";
import type { StorageConfigPayload, StorageProvider, StoragePublicView } from "../types";

interface StorageModalProps {
  open: boolean;
  storage: StoragePublicView;
  onClose: () => void;
  onSaved: (next: StoragePublicView, message: string) => void;
}

const PROVIDERS: { id: StorageProvider; label: string; hint: string }[] = [
  { id: "none", label: "Local Only", hint: "Save all calls strictly on this server" },
  { id: "r2", label: "Cloudflare R2", hint: "Zero egress S3-compatible object storage" },
  { id: "s3", label: "AWS S3", hint: "Amazon S3 bucket" },
  { id: "custom_s3", label: "B2 / S3 Compatible", hint: "Backblaze B2, MinIO, Wasabi, Tigris" },
  { id: "gdrive", label: "Google Drive", hint: "Personal or Workspace Drive via OAuth token" },
];

export const StorageModal: React.FC<StorageModalProps> = ({
  open,
  storage,
  onClose,
  onSaved,
}) => {
  const [provider, setProvider] = useState<StorageProvider>(storage.provider);
  const [autoUpload, setAutoUpload] = useState<boolean>(storage.auto_upload);
  const [bucket, setBucket] = useState<string>(storage.bucket);
  const [prefix, setPrefix] = useState<string>(storage.prefix || "calls");
  const [endpoint, setEndpoint] = useState<string>(storage.endpoint);
  const [region, setRegion] = useState<string>(storage.region);
  const [accessKeyId, setAccessKeyId] = useState<string>(storage.access_key_id);
  const [secretAccessKey, setSecretAccessKey] = useState<string>("");
  const [gdriveTokenJson, setGdriveTokenJson] = useState<string>("");
  const [gdriveClientId, setGdriveClientId] = useState<string>(storage.gdrive_client_id);
  const [gdriveClientSecret, setGdriveClientSecret] = useState<string>("");
  const [gdriveRootFolderId, setGdriveRootFolderId] = useState<string>(
    storage.gdrive_root_folder_id
  );

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProvider(storage.provider);
    setAutoUpload(storage.auto_upload);
    setBucket(storage.bucket || "");
    setPrefix(storage.prefix || "calls");
    setEndpoint(storage.endpoint || "");
    setRegion(storage.region || (storage.provider === "r2" ? "auto" : ""));
    setAccessKeyId(storage.access_key_id || "");
    setSecretAccessKey("");
    setGdriveTokenJson("");
    setGdriveClientId(storage.gdrive_client_id || "");
    setGdriveClientSecret("");
    setGdriveRootFolderId(storage.gdrive_root_folder_id || "");
    setTestResult(null);
    setError(null);
  }, [open, storage]);

  if (!open) return null;

  const buildPayload = (): StorageConfigPayload => ({
    provider,
    auto_upload: autoUpload,
    bucket: bucket.trim(),
    prefix: prefix.trim() || "calls",
    endpoint: endpoint.trim(),
    region: region.trim() || (provider === "r2" ? "auto" : "us-east-1"),
    access_key_id: accessKeyId.trim(),
    secret_access_key: secretAccessKey.trim(),
    gdrive_token_json: gdriveTokenJson.trim(),
    gdrive_client_id: gdriveClientId.trim(),
    gdrive_client_secret: gdriveClientSecret.trim(),
    gdrive_root_folder_id: gdriveRootFolderId.trim(),
  });

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await api.testStorage(buildPayload());
      setTestResult(res);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await api.saveStorage(buildPayload());
      onSaved(
        updated,
        updated.connected ? `Connected to ${updated.remote_label}` : "Switched to local-only storage"
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save storage configuration");
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      const updated = await api.disconnectStorage();
      onSaved(updated, "Disconnected cloud storage (saving locally)");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  const isS3Family =
    provider === "r2" || provider === "s3" || provider === "b2" || provider === "custom_s3";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92dvh] sm:max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl sm:rounded-xl border border-[var(--ds-border)] bg-[var(--ds-card)] shadow-2xl">
        {/* Mobile bottom-sheet handle */}
        <div className="flex justify-center pt-2.5 sm:hidden">
          <div className="h-1 w-10 rounded-full bg-[var(--ds-border-strong)]" />
        </div>

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--ds-border)] px-4 sm:px-5 py-3.5 sm:py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)]">
              <Cloud className="h-4 w-4 text-[var(--ds-fg)]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--ds-fg)]">Cloud Storage</h2>
              <p className="truncate text-xs text-[var(--ds-fg-muted)]">
                Optional — leave disconnected to save locally only
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ds-fg-muted)] hover:bg-[var(--ds-muted)] hover:text-[var(--ds-fg)] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5">
            {/* Provider Pills */}
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                Destination
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PROVIDERS.map((p) => {
                  const active =
                    provider === p.id || (p.id === "custom_s3" && provider === "b2");
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setProvider(p.id);
                        setTestResult(null);
                        setError(null);
                        if (p.id === "r2" && !region) setRegion("auto");
                      }}
                      className={`flex flex-col items-start rounded-lg border px-3 py-2.5 sm:py-2 text-left transition cursor-pointer ${
                        active
                          ? "border-[var(--ds-fg)] bg-[var(--ds-muted)]"
                          : "border-[var(--ds-border)] bg-[var(--ds-surface)] hover:border-[var(--ds-border-strong)]"
                      }`}
                    >
                      <span className="text-xs font-medium text-[var(--ds-fg)]">{p.label}</span>
                      <span className="mt-0.5 line-clamp-1 text-[10px] text-[var(--ds-fg-muted)]">
                        {p.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {provider === "none" ? (
              <div className="flex items-start gap-3 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] p-3.5 text-xs text-[var(--ds-fg-secondary)]">
                <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ds-fg-muted)]" />
                <div>
                  <p className="font-medium text-[var(--ds-fg)]">Local-only mode</p>
                  <p className="mt-1 text-[var(--ds-fg-muted)]">
                    Calls will be saved to <code className="font-mono">/data/calls</code> on the
                    deployed machine. You can connect R2, S3, or Google Drive anytime later and upload
                    selected calls retroactively.
                  </p>
                </div>
              </div>
            ) : isS3Family ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Bucket
                  </label>
                  <input
                    type="text"
                    required
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="calltap-audio"
                    className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Folder Prefix
                  </label>
                  <input
                    type="text"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    placeholder="calls"
                    className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>

                {provider !== "s3" && (
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                      Endpoint URL
                    </label>
                    <input
                      type="text"
                      required
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      placeholder={
                        provider === "r2"
                          ? "https://<account_id>.r2.cloudflarestorage.com"
                          : "https://s3.us-west-004.backblazeb2.com"
                      }
                      className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 font-mono text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                    />
                  </div>
                )}

                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Region
                  </label>
                  <input
                    type="text"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder={provider === "r2" ? "auto" : "us-east-1"}
                    className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 font-mono text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Access Key ID
                  </label>
                  <input
                    type="text"
                    required
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                    placeholder="AKIA..."
                    className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 font-mono text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Secret Access Key{" "}
                    {storage.has_secret && storage.provider === provider && (
                      <span className="font-mono text-[11px] text-[var(--ds-fg-muted)]">
                        (saved {storage.secret_hint} — leave blank to keep)
                      </span>
                    )}
                  </label>
                  <input
                    type="password"
                    required={!(storage.has_secret && storage.provider === provider)}
                    value={secretAccessKey}
                    onChange={(e) => setSecretAccessKey(e.target.value)}
                    placeholder={
                      storage.has_secret && storage.provider === provider
                        ? "Leave blank to keep existing secret"
                        : "Enter secret access key"
                    }
                    className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 font-mono text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Drive Folder Name
                  </label>
                  <input
                    type="text"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="CallTap"
                    className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Subfolder Prefix
                  </label>
                  <input
                    type="text"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    placeholder="calls"
                    className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    rclone OAuth Token JSON{" "}
                    {storage.has_gdrive_token && storage.provider === "gdrive" && (
                      <span className="text-[11px] text-[var(--ds-fg-muted)]">
                        (token saved — leave blank to keep)
                      </span>
                    )}
                  </label>
                  <textarea
                    rows={3}
                    required={!(storage.has_gdrive_token && storage.provider === "gdrive")}
                    value={gdriveTokenJson}
                    onChange={(e) => setGdriveTokenJson(e.target.value)}
                    placeholder='{"access_token":"...","token_type":"Bearer","refresh_token":"...","expiry":"..."}'
                    className="w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-2 font-mono text-[11px] text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-[var(--ds-fg-muted)]">
                    Paste the JSON output from <code className="font-mono">rclone authorize &quot;drive&quot;</code>.
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    OAuth Client ID (optional)
                  </label>
                  <input
                    type="text"
                    value={gdriveClientId}
                    onChange={(e) => setGdriveClientId(e.target.value)}
                    className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 font-mono text-xs text-[var(--ds-fg)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Root Folder ID (optional)
                  </label>
                  <input
                    type="text"
                    value={gdriveRootFolderId}
                    onChange={(e) => setGdriveRootFolderId(e.target.value)}
                    className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 font-mono text-xs text-[var(--ds-fg)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>
              </div>
            )}

            {provider !== "none" && (
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3.5 py-3 sm:py-2.5">
                <div>
                  <span className="block text-xs font-medium text-[var(--ds-fg)]">
                    Auto-upload when calls finish
                  </span>
                  <span className="block text-[11px] text-[var(--ds-fg-muted)]">
                    Turn off to upload only the recordings you select manually
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={autoUpload}
                  onChange={(e) => setAutoUpload(e.target.checked)}
                  className="h-5 w-5 sm:h-4 sm:w-4 shrink-0 accent-[var(--ds-accent)] cursor-pointer"
                />
              </label>
            )}

            {testResult && (
              <div
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                  testResult.ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-red-500/30 bg-red-500/10 text-red-400"
                }`}
              >
                {testResult.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <span className="break-all">{testResult.message}</span>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}
          </div>

          {/* Sticky Footer */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--ds-border)] bg-[var(--ds-card)] px-4 sm:px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:py-4">
            <div className="flex items-center gap-2">
              {storage.connected && storage.source === "ui" && (
                <button
                  type="button"
                  disabled={disconnecting}
                  onClick={handleDisconnect}
                  className="inline-flex h-10 sm:h-8 items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 text-xs font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-50 cursor-pointer"
                >
                  <CloudOff className="h-3.5 w-3.5" />
                  <span>{disconnecting ? "Disconnecting…" : "Disconnect"}</span>
                </button>
              )}
            </div>

            <div className="flex flex-1 sm:flex-initial items-center justify-end gap-2">
              {provider !== "none" && (
                <button
                  type="button"
                  disabled={testing}
                  onClick={handleTest}
                  className="inline-flex h-10 sm:h-8 items-center gap-1.5 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-xs font-medium text-[var(--ds-fg)] hover:border-[var(--ds-border-strong)] disabled:opacity-50 cursor-pointer"
                >
                  {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>Test Connection</span>
                </button>
              )}
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-10 sm:h-8 items-center gap-1.5 rounded-md bg-[var(--ds-btn-primary-bg)] px-4 sm:px-3.5 text-xs font-medium text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)] disabled:opacity-50 cursor-pointer"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>{provider === "none" ? "Use Local Only" : "Save Storage"}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
