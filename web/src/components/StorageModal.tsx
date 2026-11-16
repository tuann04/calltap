import React, { useEffect, useState } from "react";
import { CheckCircle2, Cloud, CloudOff, HardDrive, Loader2, X, XCircle } from "lucide-react";
import { api } from "../api";
import type { StorageConfigPayload, StoragePublicView } from "../types";
import { GDriveFields, S3Fields, STORAGE_PROVIDERS } from "./StorageFormFields";

interface StorageModalProps {
  open: boolean;
  storage: StoragePublicView;
  onClose: () => void;
  onSaved: (next: StoragePublicView, message: string) => void;
}

function initialFormState(storage: StoragePublicView): StorageConfigPayload {
  return {
    provider: storage.provider,
    auto_upload: storage.auto_upload,
    bucket: storage.bucket || "",
    prefix: storage.prefix || "calls",
    endpoint: storage.endpoint || "",
    region: storage.region || (storage.provider === "r2" ? "auto" : ""),
    access_key_id: storage.access_key_id || "",
    secret_access_key: "",
    gdrive_token_json: "",
    gdrive_client_id: storage.gdrive_client_id || "",
    gdrive_client_secret: "",
    gdrive_root_folder_id: storage.gdrive_root_folder_id || "",
  };
}

function trimmedPayload(form: StorageConfigPayload): StorageConfigPayload {
  return {
    ...form,
    bucket: form.bucket.trim(),
    prefix: form.prefix.trim() || "calls",
    endpoint: form.endpoint.trim(),
    region: form.region.trim() || (form.provider === "r2" ? "auto" : "us-east-1"),
    access_key_id: form.access_key_id.trim(),
    secret_access_key: form.secret_access_key.trim(),
    gdrive_token_json: form.gdrive_token_json.trim(),
    gdrive_client_id: form.gdrive_client_id.trim(),
    gdrive_client_secret: form.gdrive_client_secret.trim(),
    gdrive_root_folder_id: form.gdrive_root_folder_id.trim(),
  };
}

export const StorageModal: React.FC<StorageModalProps> = ({
  open,
  storage,
  onClose,
  onSaved,
}) => {
  const [form, setForm] = useState<StorageConfigPayload>(() => initialFormState(storage));
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(initialFormState(storage));
    setTestResult(null);
    setError(null);
  }, [open, storage]);

  if (!open) return null;

  const patchForm = (patch: Partial<StorageConfigPayload>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await api.testStorage(trimmedPayload(form)));
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
      const updated = await api.saveStorage(trimmedPayload(form));
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
    form.provider === "r2" ||
    form.provider === "s3" ||
    form.provider === "b2" ||
    form.provider === "custom_s3";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92dvh] sm:max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl sm:rounded-xl border border-[var(--ds-border)] bg-[var(--ds-card)] shadow-2xl">
        <div className="flex justify-center pt-2.5 sm:hidden">
          <div className="h-1 w-10 rounded-full bg-[var(--ds-border-strong)]" />
        </div>

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
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                Destination
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {STORAGE_PROVIDERS.map((p) => {
                  const active =
                    form.provider === p.id || (p.id === "custom_s3" && form.provider === "b2");
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        patchForm({
                          provider: p.id,
                          region: p.id === "r2" && !form.region ? "auto" : form.region,
                        });
                        setTestResult(null);
                        setError(null);
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

            {form.provider === "none" ? (
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
              <S3Fields form={form} storage={storage} onPatch={patchForm} />
            ) : (
              <GDriveFields form={form} storage={storage} onPatch={patchForm} />
            )}

            {form.provider !== "none" && (
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
                  checked={form.auto_upload}
                  onChange={(e) => patchForm({ auto_upload: e.target.checked })}
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
              {form.provider !== "none" && (
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
                <span>{form.provider === "none" ? "Use Local Only" : "Save Storage"}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
