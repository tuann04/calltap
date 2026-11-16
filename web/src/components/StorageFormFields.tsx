import React from "react";
import type { StorageConfigPayload, StorageProvider, StoragePublicView } from "../types";

export const STORAGE_PROVIDERS: { id: StorageProvider; label: string; hint: string }[] = [
  { id: "none", label: "Local Only", hint: "Save all calls strictly on this server" },
  { id: "r2", label: "Cloudflare R2", hint: "Zero egress S3-compatible object storage" },
  { id: "s3", label: "AWS S3", hint: "Amazon S3 bucket" },
  { id: "custom_s3", label: "B2 / S3 Compatible", hint: "Backblaze B2, MinIO, Wasabi, Tigris" },
  { id: "gdrive", label: "Google Drive", hint: "Personal or Workspace Drive via OAuth token" },
];

const LABEL_CLS = "mb-1 block text-xs font-medium text-[var(--ds-fg-secondary)]";
const INPUT_CLS =
  "h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1.5 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none";
const MONO_INPUT_CLS = `${INPUT_CLS} font-mono`;

const Field: React.FC<{ label: React.ReactNode; className?: string; children: React.ReactNode }> = ({
  label,
  className,
  children,
}) => (
  <div className={className}>
    <label className={LABEL_CLS}>{label}</label>
    {children}
  </div>
);

interface ProviderFieldsProps {
  form: StorageConfigPayload;
  storage: StoragePublicView;
  onPatch: (patch: Partial<StorageConfigPayload>) => void;
}

export const S3Fields: React.FC<ProviderFieldsProps> = ({ form, storage, onPatch }) => {
  const hasSavedSecret = storage.has_secret && storage.provider === form.provider;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Bucket">
        <input
          type="text"
          required
          value={form.bucket}
          onChange={(e) => onPatch({ bucket: e.target.value })}
          placeholder="calltap-audio"
          className={INPUT_CLS}
        />
      </Field>
      <Field label="Folder Prefix">
        <input
          type="text"
          value={form.prefix}
          onChange={(e) => onPatch({ prefix: e.target.value })}
          placeholder="calls"
          className={INPUT_CLS}
        />
      </Field>
      {form.provider !== "s3" && (
        <Field label="Endpoint URL" className="sm:col-span-2">
          <input
            type="text"
            required
            value={form.endpoint}
            onChange={(e) => onPatch({ endpoint: e.target.value })}
            placeholder={
              form.provider === "r2"
                ? "https://<account_id>.r2.cloudflarestorage.com"
                : "https://s3.us-west-004.backblazeb2.com"
            }
            className={MONO_INPUT_CLS}
          />
        </Field>
      )}
      <Field label="Region">
        <input
          type="text"
          value={form.region}
          onChange={(e) => onPatch({ region: e.target.value })}
          placeholder={form.provider === "r2" ? "auto" : "us-east-1"}
          className={MONO_INPUT_CLS}
        />
      </Field>
      <Field label="Access Key ID">
        <input
          type="text"
          required
          value={form.access_key_id}
          onChange={(e) => onPatch({ access_key_id: e.target.value })}
          placeholder="AKIA..."
          className={MONO_INPUT_CLS}
        />
      </Field>
      <Field
        className="sm:col-span-2"
        label={
          <>
            Secret Access Key{" "}
            {hasSavedSecret && (
              <span className="font-mono text-[11px] text-[var(--ds-fg-muted)]">
                (saved {storage.secret_hint} — leave blank to keep)
              </span>
            )}
          </>
        }
      >
        <input
          type="password"
          required={!hasSavedSecret}
          value={form.secret_access_key}
          onChange={(e) => onPatch({ secret_access_key: e.target.value })}
          placeholder={
            hasSavedSecret ? "Leave blank to keep existing secret" : "Enter secret access key"
          }
          className={MONO_INPUT_CLS}
        />
      </Field>
    </div>
  );
};

export const GDriveFields: React.FC<ProviderFieldsProps> = ({ form, storage, onPatch }) => {
  const hasSavedToken = storage.has_gdrive_token && storage.provider === "gdrive";
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Drive Folder Name">
        <input
          type="text"
          value={form.bucket}
          onChange={(e) => onPatch({ bucket: e.target.value })}
          placeholder="CallTap"
          className={INPUT_CLS}
        />
      </Field>
      <Field label="Subfolder Prefix">
        <input
          type="text"
          value={form.prefix}
          onChange={(e) => onPatch({ prefix: e.target.value })}
          placeholder="calls"
          className={INPUT_CLS}
        />
      </Field>
      <Field
        className="sm:col-span-2"
        label={
          <>
            rclone OAuth Token JSON{" "}
            {hasSavedToken && (
              <span className="text-[11px] text-[var(--ds-fg-muted)]">
                (token saved — leave blank to keep)
              </span>
            )}
          </>
        }
      >
        <textarea
          rows={3}
          required={!hasSavedToken}
          value={form.gdrive_token_json}
          onChange={(e) => onPatch({ gdrive_token_json: e.target.value })}
          placeholder='{"access_token":"...","token_type":"Bearer","refresh_token":"...","expiry":"..."}'
          className="w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-2 font-mono text-[11px] text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
        />
        <p className="mt-1 text-[11px] text-[var(--ds-fg-muted)]">
          Paste the JSON output from <code className="font-mono">rclone authorize &quot;drive&quot;</code>.
        </p>
      </Field>
      <Field label="OAuth Client ID (optional)">
        <input
          type="text"
          value={form.gdrive_client_id}
          onChange={(e) => onPatch({ gdrive_client_id: e.target.value })}
          className={MONO_INPUT_CLS}
        />
      </Field>
      <Field label="Root Folder ID (optional)">
        <input
          type="text"
          value={form.gdrive_root_folder_id}
          onChange={(e) => onPatch({ gdrive_root_folder_id: e.target.value })}
          className={MONO_INPUT_CLS}
        />
      </Field>
    </div>
  );
};
