import React, { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudOff,
  ExternalLink,
  Loader2,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "../api";
import type { CallMetadata, UploadStatus } from "../types";
import {
  extractHostname,
  formatCallTitle,
  formatDuration,
  formatServiceLabel,
  formatStartedAt,
} from "../utils/callDisplay";
import { CallNotesDrawer } from "./CallNotesDrawer";
import { WaveformPlayer } from "./WaveformPlayer";

interface CallCardProps {
  call: CallMetadata;
  selected: boolean;
  cloudConnected: boolean;
  onToggleSelect: (callId: string) => void;
  onUpdated: (updated: CallMetadata) => void;
  onRequestDelete: (call: CallMetadata) => void;
  onNotify: (msg: string, tone?: "ok" | "err") => void;
}

const UPLOAD_BADGE_CONFIG: Record<
  UploadStatus,
  { label: string; className: string; icon?: "cloud" | "spinner" | "off" }
> = {
  uploaded: {
    label: "Synced",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
    icon: "cloud",
  },
  uploading: {
    label: "Uploading",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    icon: "spinner",
  },
  pending: {
    label: "Pending upload",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  },
  failed: {
    label: "Upload failed",
    className: "border-red-500/30 bg-red-500/10 text-red-400",
  },
  disabled: {
    label: "Local only",
    className: "border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-fg-muted)]",
    icon: "off",
  },
};

const UploadBadge: React.FC<{ call: CallMetadata }> = ({ call }) => {
  const cfg = UPLOAD_BADGE_CONFIG[call.upload_status] ?? UPLOAD_BADGE_CONFIG.disabled;
  const title =
    call.upload_status === "uploaded"
      ? (call.remote_uri ?? "Uploaded to cloud")
      : call.upload_status === "failed"
        ? (call.upload_error ?? "Upload failed")
        : undefined;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cfg.className}`}
    >
      {cfg.icon === "cloud" && <Cloud className="h-3 w-3" />}
      {cfg.icon === "spinner" && <Loader2 className="h-3 w-3 animate-spin" />}
      {cfg.icon === "off" && <CloudOff className="h-3 w-3" />}
      <span>{cfg.label}</span>
    </span>
  );
};

export const CallCard: React.FC<CallCardProps> = ({
  call,
  selected,
  cloudConnected,
  onToggleSelect,
  onUpdated,
  onRequestDelete,
  onNotify,
}) => {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(call.title);
  const [savingTitle, setSavingTitle] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(call.title);
  }, [call.title, editingTitle]);

  const saveTitle = async () => {
    const trimmed = titleDraft.trim();
    if (trimmed === call.title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      const updated = await api.patchCall(call.call_id, { title: trimmed });
      onUpdated(updated);
      setEditingTitle(false);
      onNotify("Recording renamed");
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Failed to rename", "err");
    } finally {
      setSavingTitle(false);
    }
  };

  const handleUpload = async () => {
    setUploading(true);
    try {
      const updated = await api.uploadCall(call.call_id);
      onUpdated(updated);
      onNotify("Queued upload to cloud storage");
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Upload failed", "err");
    } finally {
      setUploading(false);
    }
  };

  const displayTitle = formatCallTitle(call);
  const pageHost = extractHostname(call.page_url);
  const serviceBadge = formatServiceLabel(call.service, null);
  const canUpload =
    cloudConnected &&
    call.status === "completed" &&
    !call.local_pruned &&
    call.upload_status !== "uploaded" &&
    call.upload_status !== "uploading";

  return (
    <article
      className={`rounded-xl border transition-colors ${
        selected
          ? "border-[var(--ds-fg)] bg-[var(--ds-card)]"
          : "border-[var(--ds-border)] bg-[var(--ds-card)] hover:border-[var(--ds-border-strong)]"
      } p-3.5 sm:p-4`}
    >
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <input
            type="checkbox"
            checked={selected}
            disabled={call.status === "recording"}
            onChange={() => onToggleSelect(call.call_id)}
            aria-label={`Select ${displayTitle}`}
            className="mt-0.5 sm:mt-1 h-5 w-5 sm:h-4 sm:w-4 shrink-0 rounded accent-[var(--ds-fg)] cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
          />

          <div className="min-w-0 flex-1">
            {editingTitle ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={titleDraft}
                  placeholder={displayTitle}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveTitle();
                    } else if (e.key === "Escape") {
                      setTitleDraft(call.title);
                      setEditingTitle(false);
                    }
                  }}
                  className="h-9 sm:h-7 min-w-0 flex-1 max-w-sm rounded-md border border-[var(--ds-border-strong)] bg-[var(--ds-surface)] px-2.5 text-sm font-medium text-[var(--ds-fg)] focus:border-[var(--ds-fg)] focus:outline-none"
                />
                <button
                  type="button"
                  disabled={savingTitle}
                  onClick={saveTitle}
                  className="inline-flex h-9 w-9 sm:h-7 sm:w-7 shrink-0 items-center justify-center rounded-md bg-[var(--ds-btn-primary-bg)] text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)] cursor-pointer"
                  title="Save title"
                >
                  {savingTitle ? (
                    <Loader2 className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(call.title);
                    setEditingTitle(false);
                  }}
                  className="inline-flex h-9 w-9 sm:h-7 sm:w-7 shrink-0 items-center justify-center rounded-md border border-[var(--ds-border)] text-[var(--ds-fg-muted)] hover:text-[var(--ds-fg)] cursor-pointer"
                  title="Cancel"
                >
                  <X className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <h3
                  onClick={() => setEditingTitle(true)}
                  className="min-w-0 truncate text-sm font-semibold text-[var(--ds-fg)] cursor-pointer hover:underline decoration-[var(--ds-border-strong)] underline-offset-4"
                  title="Click to rename"
                >
                  {displayTitle}
                </h3>
                <button
                  type="button"
                  onClick={() => setEditingTitle(true)}
                  className="inline-flex h-7 w-7 sm:h-6 sm:w-6 shrink-0 items-center justify-center rounded text-[var(--ds-fg-muted)] hover:bg-[var(--ds-muted)] hover:text-[var(--ds-fg)] cursor-pointer"
                  title="Rename recording"
                >
                  <Pencil className="h-3.5 w-3.5 sm:h-3 sm:w-3" />
                </button>
              </div>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[var(--ds-fg-muted)]">
              <span className="rounded bg-[var(--ds-muted)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--ds-fg-secondary)]">
                {serviceBadge}
              </span>
              {call.page_url && pageHost && (
                <a
                  href={call.page_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 font-mono text-[11px] text-[var(--ds-fg-secondary)] hover:text-[var(--ds-fg)] hover:underline"
                  title={call.page_url}
                >
                  <span className="max-w-[160px] sm:max-w-[180px] truncate">{pageHost}</span>
                  <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                </a>
              )}
              <span>{formatStartedAt(call.started_at)}</span>
              <span className="font-mono tabular-nums">{formatDuration(call.duration_seconds)}</span>
              {call.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-[var(--ds-border)] px-2 py-0.5 text-[10px] text-[var(--ds-fg-secondary)]"
                >
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
          <div className="flex items-center gap-2">
            {call.status === "recording" && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-0.5 text-[11px] font-medium text-red-500">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                Recording
              </span>
            )}
            <UploadBadge call={call} />
          </div>

          <div className="flex items-center gap-1.5">
            {canUpload && (
              <button
                type="button"
                disabled={uploading}
                onClick={handleUpload}
                className="inline-flex h-8 sm:h-7 items-center gap-1 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2.5 text-xs sm:text-[11px] font-medium text-[var(--ds-fg)] hover:border-[var(--ds-border-strong)] disabled:opacity-50 cursor-pointer"
                title="Upload this recording to connected cloud storage"
              >
                {uploading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Upload className="h-3 w-3" />
                )}
                <span>{call.upload_status === "failed" ? "Retry" : "Upload"}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              className="inline-flex h-8 sm:h-7 items-center gap-1 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2.5 sm:px-2 text-xs sm:text-[11px] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] cursor-pointer"
              title="Edit notes and tags"
            >
              <span>Notes</span>
              {detailsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>

            <button
              type="button"
              disabled={call.status === "recording"}
              onClick={() => onRequestDelete(call)}
              className="inline-flex h-8 w-8 sm:h-7 sm:w-7 items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-fg-muted)] hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              title="Delete recording"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {call.upload_status === "failed" && call.upload_error && (
        <div className="mb-3 break-words rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 font-mono text-[11px] text-red-400">
          {call.upload_error}
        </div>
      )}

      <WaveformPlayer call={call} />

      {detailsOpen && (
        <CallNotesDrawer call={call} onUpdated={onUpdated} onNotify={onNotify} />
      )}
    </article>
  );
};
