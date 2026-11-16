import React from "react";
import { Cloud, CloudOff, ExternalLink, Loader2, Mic, Power, Square } from "lucide-react";
import type { StatusResponse, StoragePublicView } from "../types";
import { formatCallTitle, formatServiceLabel } from "../utils/callDisplay";

interface RecorderHeroProps {
  status: StatusResponse | null;
  storageView: StoragePublicView;
  cloudConnected: boolean;
  vmSleeping: boolean;
  wakeUrl: string;
  nekoUrl: string | null;
  activeTabLabel: string | null;
  elapsedText: string;
  serviceChoice: string;
  onServiceChoiceChange: (val: string) => void;
  newTitle: string;
  onNewTitleChange: (val: string) => void;
  starting: boolean;
  stopping: boolean;
  onStart: (e: React.FormEvent) => void;
  onStop: () => void;
  onToggleAutoDetect: () => void;
  onOpenStorage: () => void;
}

export const RecorderHero: React.FC<RecorderHeroProps> = ({
  status,
  storageView,
  cloudConnected,
  vmSleeping,
  wakeUrl,
  nekoUrl,
  activeTabLabel,
  elapsedText,
  serviceChoice,
  onServiceChoiceChange,
  newTitle,
  onNewTitleChange,
  starting,
  stopping,
  onStart,
  onStop,
  onToggleAutoDetect,
  onOpenStorage,
}) => {
  const statusDot = vmSleeping
    ? "bg-sky-400"
    : status?.pulse_healthy
      ? "bg-emerald-500"
      : "bg-red-500";
  const statusText = vmSleeping
    ? "VM sleeping ($0/hr) · Serverless R2"
    : status?.pulse_healthy
      ? "Audio ready"
      : "Pulse offline";

  return (
    <section className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-card)] shadow-xs">
      <div className="flex md:hidden items-center justify-between gap-2 border-b border-[var(--ds-border)] bg-[var(--ds-surface)] px-4 py-2 text-xs rounded-t-xl">
        <span className="inline-flex items-center gap-1.5 text-[var(--ds-fg-secondary)]">
          <span className={`h-2 w-2 rounded-full ${statusDot}`} />
          {statusText}
        </span>
        {activeTabLabel && (
          <span className="max-w-[170px] truncate rounded bg-[var(--ds-muted)] px-2 py-0.5 font-mono text-[11px] text-[var(--ds-fg)]">
            {activeTabLabel}
          </span>
        )}
      </div>

      <div className="p-4 sm:p-5">
        {vmSleeping ? (
          <div className="flex flex-col gap-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                  SERVERLESS ARCHIVE · $0/HR COMPUTE
                </span>
              </div>
              <h1 className="text-sm sm:text-base font-semibold text-[var(--ds-fg)]">
                Recorder VM is deallocated — browsing &amp; playing directly from Cloudflare R2
              </h1>
              <p className="text-xs text-[var(--ds-fg-muted)]">
                Playback, waveform scrubbing, search, notes, tags, and deletion run at the edge with 0s cold start. Wake the VM only when you want to record a live call.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {nekoUrl && (
                <a
                  href={nekoUrl}
                  className="inline-flex h-10 sm:h-9 flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3.5 text-xs font-medium text-[var(--ds-fg)] hover:border-[var(--ds-border-strong)] no-underline"
                >
                  <span>Open Neko</span>
                  <ExternalLink className="h-3.5 w-3.5 text-[var(--ds-fg-muted)]" />
                </a>
              )}
              <a
                href={wakeUrl}
                className="inline-flex h-10 sm:h-9 flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-md bg-[var(--ds-btn-primary-bg)] px-4 text-xs font-semibold text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)] no-underline"
              >
                <Power className="h-3.5 w-3.5" />
                <span>Wake VM to Record</span>
              </a>
            </div>
          </div>
        ) : status?.active_call ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-0.5 text-[11px] font-medium text-red-500">
                  <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                  LIVE RECORDING
                </span>
                <span className="rounded bg-[var(--ds-muted)] px-2 py-0.5 font-mono text-xs text-[var(--ds-fg-secondary)]">
                  {formatServiceLabel(status.active_call.service, status.active_call.page_url)}
                </span>
              </div>
              <h1 className="truncate text-base font-semibold text-[var(--ds-fg)]">
                {formatCallTitle(status.active_call)}
              </h1>
              <p className="truncate font-mono text-xs text-[var(--ds-fg-muted)]">
                {status.active_call.page_url || "Capturing microphone + browser audio"}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] px-4 py-2 font-mono text-xl sm:text-lg font-semibold tabular-nums text-[var(--ds-fg)]">
                {elapsedText}
              </div>
              <button
                type="button"
                disabled={stopping}
                onClick={onStop}
                className="inline-flex h-11 sm:h-10 flex-1 sm:flex-initial items-center justify-center gap-2 rounded-lg bg-red-600 px-4 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50 cursor-pointer"
              >
                {stopping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-3.5 w-3.5 fill-current" />
                )}
                <span>Stop &amp; Save</span>
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={onStart} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="w-full sm:w-48">
              <label className="mb-1.5 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                Service
              </label>
              <select
                value={serviceChoice}
                onChange={(e) => onServiceChoiceChange(e.target.value)}
                className="h-11 sm:h-9 w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-xs font-medium text-[var(--ds-fg)] focus:border-[var(--ds-fg)] focus:outline-none"
              >
                <option value="auto">Auto-detect (from tab)</option>
                <option value="sesame">Sesame</option>
                <option value="chatgpt">ChatGPT Voice</option>
                <option value="gemini">Gemini Live</option>
                <option value="custom">Custom Call</option>
              </select>
            </div>

            <div className="flex-1">
              <label className="mb-1.5 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                Recording Title <span className="text-[var(--ds-fg-muted)]">(optional)</span>
              </label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => onNewTitleChange(e.target.value)}
                placeholder="e.g., Evening English practice with Maya"
                className="h-11 sm:h-9 w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={starting}
              className="inline-flex h-11 sm:h-9 w-full sm:w-auto shrink-0 items-center justify-center gap-2 rounded-md bg-[var(--ds-btn-primary-bg)] px-4 text-xs font-semibold text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)] disabled:opacity-50 cursor-pointer"
            >
              {starting ? (
                <Loader2 className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" />
              ) : (
                <Mic className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              )}
              <span>Start Recording</span>
            </button>
          </form>
        )}
      </div>

      <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between border-t border-[var(--ds-border)] bg-[var(--ds-surface)] px-4 sm:px-5 py-3 sm:py-2.5 text-xs text-[var(--ds-fg-muted)] rounded-b-xl">
        <label className="inline-flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={Boolean(status?.auto_detect)}
            disabled={vmSleeping}
            onChange={onToggleAutoDetect}
            className="h-4 w-4 sm:h-3.5 sm:w-3.5 accent-[var(--ds-fg)] cursor-pointer disabled:opacity-50"
          />
          <span className="text-[var(--ds-fg-secondary)]">
            Auto-detect calls from browser microphone
          </span>
        </label>

        <button
          type="button"
          onClick={() => !vmSleeping && onOpenStorage()}
          className="inline-flex items-center gap-1.5 text-left text-xs text-[var(--ds-fg-secondary)] hover:text-[var(--ds-fg)] cursor-pointer"
        >
          {cloudConnected ? (
            <>
              <Cloud className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              <span className="truncate">
                {vmSleeping
                  ? `Serving archive directly from ${storageView.remote_label}`
                  : storageView.auto_upload
                    ? `Auto-uploading to ${storageView.remote_label}`
                    : `Connected (${storageView.remote_label}) — manual`}
              </span>
            </>
          ) : (
            <>
              <CloudOff className="h-3.5 w-3.5 shrink-0" />
              <span>Saving locally · Connect R2 / S3 / Google Drive</span>
            </>
          )}
        </button>
      </div>
    </section>
  );
};
