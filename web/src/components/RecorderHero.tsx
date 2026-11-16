import React from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  ExternalLink,
  Loader2,
  Mic,
  Power,
  Square,
} from "lucide-react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import type { StatusResponse, StoragePublicView } from "../types";
import { formatCallTitle, formatServiceLabel } from "../utils/callDisplay";

const SERVICE_OPTIONS = [
  { value: "auto", label: "Auto-detect (from tab)" },
  { value: "sesame", label: "Sesame" },
  { value: "chatgpt", label: "ChatGPT Voice" },
  { value: "gemini", label: "Gemini Live" },
  { value: "custom", label: "Custom Call" },
];

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
                <Button
                  render={<a href={nekoUrl} />}
                  className="inline-flex h-10 sm:h-9 flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3.5 text-xs font-medium text-[var(--ds-fg)] hover:border-[var(--ds-border-strong)] no-underline"
                >
                  <span>Open Neko</span>
                  <ExternalLink className="h-3.5 w-3.5 text-[var(--ds-fg-muted)]" aria-hidden="true" />
                </Button>
              )}
              <Button
                data-variant="solid"
                render={<a href={wakeUrl} />}
                className="inline-flex h-10 sm:h-9 flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-md border-0 bg-[var(--ds-btn-primary-bg)] px-4 text-xs font-semibold text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)] no-underline"
              >
                <Power className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Wake VM to Record</span>
              </Button>
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
              <Button
                type="button"
                disabled={stopping}
                onClick={onStop}
                className="inline-flex h-11 sm:h-10 flex-1 sm:flex-initial items-center justify-center gap-2 rounded-lg border-0 bg-red-600 px-4 text-xs font-semibold text-white hover:bg-red-500"
              >
                {stopping ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                )}
                <span>Stop &amp; Save</span>
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={onStart} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field className="w-full sm:w-48">
              <FieldLabel className="text-xs font-medium text-[var(--ds-fg-secondary)]">
                Service
              </FieldLabel>
              <Select
                items={SERVICE_OPTIONS}
                value={serviceChoice}
                onValueChange={(next) => {
                  if (next) onServiceChoiceChange(next);
                }}
              >
                <SelectTrigger className="h-11 sm:h-9 w-full border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-xs font-medium text-[var(--ds-fg)]">
                  <SelectValue />
                  <ChevronDown className="h-3.5 w-3.5 text-[var(--ds-fg-muted)]" aria-hidden="true" />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <SelectItemText>{opt.label}</SelectItemText>
                      <SelectItemIndicator>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      </SelectItemIndicator>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field className="flex-1">
              <FieldLabel className="text-xs font-medium text-[var(--ds-fg-secondary)]">
                Recording Title <span className="text-[var(--ds-fg-muted)]">(optional)</span>
              </FieldLabel>
              <Input
                type="text"
                value={newTitle}
                onValueChange={onNewTitleChange}
                placeholder="e.g., Evening English practice with Maya"
                className="h-11 sm:h-9 w-full border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)]"
              />
            </Field>

            <Button
              type="submit"
              data-variant="solid"
              disabled={starting}
              className="inline-flex h-11 sm:h-9 w-full sm:w-auto shrink-0 items-center justify-center gap-2 rounded-md border-0 bg-[var(--ds-btn-primary-bg)] px-4 text-xs font-semibold text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)]"
            >
              {starting ? (
                <Loader2 className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Mic className="h-4 w-4 sm:h-3.5 sm:w-3.5" aria-hidden="true" />
              )}
              <span>Start Recording</span>
            </Button>
          </form>
        )}
      </div>

      <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between border-t border-[var(--ds-border)] bg-[var(--ds-surface)] px-4 sm:px-5 py-3 sm:py-2.5 text-xs text-[var(--ds-fg-muted)] rounded-b-xl">
        <Field className="flex-row items-center gap-2.5">
          <Switch
            checked={Boolean(status?.auto_detect)}
            disabled={vmSleeping}
            onCheckedChange={(next) => {
              if (next !== Boolean(status?.auto_detect)) onToggleAutoDetect();
            }}
          >
            <SwitchThumb />
          </Switch>
          <FieldLabel className="cursor-pointer text-xs text-[var(--ds-fg-secondary)]">
            Auto-detect calls from browser microphone
          </FieldLabel>
        </Field>

        <Button
          type="button"
          disabled={vmSleeping}
          onClick={onOpenStorage}
          className="inline-flex h-auto items-center gap-1.5 border-0 bg-transparent px-0 text-left text-xs text-[var(--ds-fg-secondary)] hover:text-[var(--ds-fg)]"
        >
          {cloudConnected ? (
            <>
              <Cloud className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
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
              <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Saving locally · Connect R2 / S3 / Google Drive</span>
            </>
          )}
        </Button>
      </div>
    </section>
  );
};
