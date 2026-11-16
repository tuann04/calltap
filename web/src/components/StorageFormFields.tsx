import React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  PasswordInput,
  PasswordInputControl,
  PasswordInputToggle,
} from "@ui-sdk/react/password-input";
import { Textarea } from "@ui-sdk/react/textarea";
import type { StorageConfigPayload, StorageProvider, StoragePublicView } from "../types";

export const STORAGE_PROVIDERS: { id: StorageProvider; label: string; hint: string }[] = [
  { id: "none", label: "Local Only", hint: "Save all calls strictly on this server" },
  { id: "r2", label: "Cloudflare R2", hint: "Zero egress S3-compatible object storage" },
  { id: "s3", label: "AWS S3", hint: "Amazon S3 bucket" },
  { id: "custom_s3", label: "B2 / S3 Compatible", hint: "Backblaze B2, MinIO, Wasabi, Tigris" },
  { id: "gdrive", label: "Google Drive", hint: "Personal or Workspace Drive via OAuth token" },
];

const LABEL_CLS = "text-xs font-medium text-[var(--ds-fg-secondary)]";
const INPUT_CLS =
  "h-10 sm:h-8 w-full border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)]";
const MONO_INPUT_CLS = `${INPUT_CLS} font-mono`;

interface ProviderFieldsProps {
  form: StorageConfigPayload;
  storage: StoragePublicView;
  onPatch: (patch: Partial<StorageConfigPayload>) => void;
}

export const S3Fields: React.FC<ProviderFieldsProps> = ({ form, storage, onPatch }) => {
  const hasSavedSecret = storage.has_secret && storage.provider === form.provider;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field>
        <FieldLabel className={LABEL_CLS}>Bucket</FieldLabel>
        <Input
          type="text"
          required
          value={form.bucket}
          onValueChange={(bucket) => onPatch({ bucket })}
          placeholder="calltap-audio"
          className={INPUT_CLS}
        />
      </Field>

      <Field>
        <FieldLabel className={LABEL_CLS}>Folder Prefix</FieldLabel>
        <Input
          type="text"
          value={form.prefix}
          onValueChange={(prefix) => onPatch({ prefix })}
          placeholder="calls"
          className={INPUT_CLS}
        />
      </Field>

      {form.provider !== "s3" && (
        <Field className="sm:col-span-2">
          <FieldLabel className={LABEL_CLS}>Endpoint URL</FieldLabel>
          <Input
            type="text"
            required
            value={form.endpoint}
            onValueChange={(endpoint) => onPatch({ endpoint })}
            placeholder={
              form.provider === "r2"
                ? "https://<account_id>.r2.cloudflarestorage.com"
                : "https://s3.us-west-004.backblazeb2.com"
            }
            className={MONO_INPUT_CLS}
          />
        </Field>
      )}

      <Field>
        <FieldLabel className={LABEL_CLS}>Region</FieldLabel>
        <Input
          type="text"
          value={form.region}
          onValueChange={(region) => onPatch({ region })}
          placeholder={form.provider === "r2" ? "auto" : "us-east-1"}
          className={MONO_INPUT_CLS}
        />
      </Field>

      <Field>
        <FieldLabel className={LABEL_CLS}>Access Key ID</FieldLabel>
        <Input
          type="text"
          required
          value={form.access_key_id}
          onValueChange={(access_key_id) => onPatch({ access_key_id })}
          placeholder="AKIA..."
          className={MONO_INPUT_CLS}
        />
      </Field>

      <Field className="sm:col-span-2">
        <FieldLabel className={LABEL_CLS}>Secret Access Key</FieldLabel>
        <PasswordInput
          required={!hasSavedSecret}
          autoComplete="new-password"
          value={form.secret_access_key}
          onValueChange={(secret_access_key) => onPatch({ secret_access_key })}
          className="h-10 sm:h-8 w-full border-[var(--ds-border)] bg-[var(--ds-surface)]"
        >
          <PasswordInputControl
            placeholder={
              hasSavedSecret ? "Leave blank to keep existing secret" : "Enter secret access key"
            }
            className="font-mono text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)]"
          />
          <PasswordInputToggle aria-label="Show secret access key">
            {(state) =>
              state.visible ? (
                <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              )
            }
          </PasswordInputToggle>
        </PasswordInput>
        {hasSavedSecret && (
          <FieldDescription className="font-mono text-[11px]">
            Saved {storage.secret_hint} — leave blank to keep existing secret
          </FieldDescription>
        )}
      </Field>
    </div>
  );
};

export const GDriveFields: React.FC<ProviderFieldsProps> = ({ form, storage, onPatch }) => {
  const hasSavedToken = storage.has_gdrive_token && storage.provider === "gdrive";
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field>
        <FieldLabel className={LABEL_CLS}>Drive Folder Name</FieldLabel>
        <Input
          type="text"
          value={form.bucket}
          onValueChange={(bucket) => onPatch({ bucket })}
          placeholder="CallTap"
          className={INPUT_CLS}
        />
      </Field>

      <Field>
        <FieldLabel className={LABEL_CLS}>Subfolder Prefix</FieldLabel>
        <Input
          type="text"
          value={form.prefix}
          onValueChange={(prefix) => onPatch({ prefix })}
          placeholder="calls"
          className={INPUT_CLS}
        />
      </Field>

      <Field className="sm:col-span-2">
        <FieldLabel className={LABEL_CLS}>rclone OAuth Token JSON</FieldLabel>
        <Textarea
          rows={3}
          required={!hasSavedToken}
          data-agent-secret=""
          value={form.gdrive_token_json}
          onValueChange={(gdrive_token_json) => onPatch({ gdrive_token_json })}
          placeholder='{"access_token":"...","token_type":"Bearer","refresh_token":"...","expiry":"..."}'
          className="min-h-20 w-full border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-2 font-mono text-[11px] text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)]"
        />
        <FieldDescription className="text-[11px]">
          {hasSavedToken ? "Token saved — leave blank to keep. " : ""}
          Paste the JSON output from <code className="font-mono">rclone authorize &quot;drive&quot;</code>.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel className={LABEL_CLS}>OAuth Client ID (optional)</FieldLabel>
        <Input
          type="text"
          value={form.gdrive_client_id}
          onValueChange={(gdrive_client_id) => onPatch({ gdrive_client_id })}
          className={MONO_INPUT_CLS}
        />
      </Field>

      <Field>
        <FieldLabel className={LABEL_CLS}>Root Folder ID (optional)</FieldLabel>
        <Input
          type="text"
          value={form.gdrive_root_folder_id}
          onValueChange={(gdrive_root_folder_id) => onPatch({ gdrive_root_folder_id })}
          className={MONO_INPUT_CLS}
        />
      </Field>
    </div>
  );
};
