import React, { useState } from "react";
import { Download, Pause, Play, RotateCcw, RotateCw, Scissors, Waves } from "lucide-react";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { Slider, SliderControl, SliderThumb, SliderTrack } from "@ui-sdk/react/slider";
import { Toolbar, ToolbarButton, ToolbarLink } from "@ui-sdk/react/toolbar";
import { api } from "../api";
import { useWaveformAudio, type TrackKey } from "../hooks/useWaveformAudio";
import type { AudioEditMode, CallMetadata } from "../types";
import { formatCallTitle, formatTime } from "../utils/callDisplay";
import type { NotifyFn } from "./AppToastRegion";
import { AudioTrimPanel } from "./AudioTrimPanel";

interface WaveformPlayerProps {
  call: CallMetadata;
  vmSleeping?: boolean;
  wakeUrl?: string;
  onEdited?: (updated: CallMetadata) => void;
  onNotify?: NotifyFn;
}

interface WaveformBarsProps {
  peaks: number[];
  viewHeight: number;
  minBarHeight: number;
  progress: number;
  align: "top" | "bottom" | "center";
  activeFill?: string;
  activeClass?: string;
  inactiveClass: string;
  svgClassName: string;
}

const WaveformBars: React.FC<WaveformBarsProps> = ({
  peaks,
  viewHeight,
  minBarHeight,
  progress,
  align,
  activeFill = "currentColor",
  activeClass = "",
  inactiveClass,
  svgClassName,
}) => (
  <svg
    viewBox={`0 0 ${peaks.length * 4} ${viewHeight}`}
    preserveAspectRatio="none"
    className={svgClassName}
    aria-hidden="true"
  >
    {peaks.map((amp, i) => {
      const active = (i + 0.5) / peaks.length <= progress;
      const h = Math.max(minBarHeight, Math.round(amp * viewHeight * 10) / 10);
      const y = align === "bottom" ? viewHeight - h : align === "center" ? (viewHeight - h) / 2 : 0;
      return (
        <rect
          key={i}
          x={i * 4 + 0.6}
          y={y}
          width={2.8}
          height={h}
          rx={0.8}
          fill={active ? activeFill : "currentColor"}
          className={active ? activeClass : inactiveClass}
        />
      );
    })}
  </svg>
);

export const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
  call,
  vmSleeping = false,
  wakeUrl,
  onEdited,
  onNotify,
}) => {
  const {
    containerRef,
    audioProps,
    availableTracks,
    track,
    waveform,
    waveformError,
    loadingWave,
    playing,
    previewActive,
    displayTime,
    totalDuration,
    progress,
    speed,
    audioError,
    isUnplayablePruned,
    versionQuery,
    handleSliderChange,
    handleSliderCommit,
    togglePlay,
    startPreview,
    stopPreview,
    skip,
    switchTrack,
    cycleSpeed,
  } = useWaveformAudio(call);

  const [editing, setEditing] = useState(false);
  const [editMode, setEditMode] = useState<AudioEditMode>("keep");
  const [editRange, setEditRange] = useState<[number, number]>([0, 0]);

  if (call.status !== "completed") {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-between rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3.5 py-3 text-xs text-[var(--ds-fg-secondary)]"
      >
        <div className="flex items-center gap-2">
          <Waves className="h-3.5 w-3.5 animate-pulse text-red-500" aria-hidden="true" />
          <span>
            {call.status === "recording"
              ? "Recording in progress — waveform and playback become available once stopped."
              : call.status === "finalizing"
                ? "Finalizing audio tracks and generating waveform…"
                : "Recording ended with an error."}
          </span>
        </div>
      </div>
    );
  }

  if (isUnplayablePruned) {
    return (
      <div
        ref={containerRef}
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3.5 py-3 text-xs text-[var(--ds-fg-secondary)]"
      >
        <span>Local audio was pruned after cloud upload.</span>
        {call.remote_uri && (
          <span className="font-mono text-[11px] text-[var(--ds-fg-muted)]">{call.remote_uri}</span>
        )}
      </div>
    );
  }

  const displayTitle = formatCallTitle(call);
  const editBlockedReason = vmSleeping
    ? "Wake the recorder VM to edit audio"
    : call.local_pruned
      ? "Local audio was pruned after cloud upload"
      : totalDuration <= 0.6
        ? "Recording is too short to edit"
        : null;
  const youPeaks = waveform?.tracks.you ?? [];
  const agentPeaks = waveform?.tracks.agent ?? [];
  const mixPeaks = waveform?.tracks.mix ?? [];
  const hasDual = youPeaks.length > 0 && agentPeaks.length > 0;
  const fallbackPeaks = mixPeaks.length > 0 ? mixPeaks : youPeaks.length > 0 ? youPeaks : agentPeaks;
  const singlePeaks =
    fallbackPeaks.length > 0 ? fallbackPeaks : Array.from({ length: 96 }, () => 0.15);

  const [selStart, selEnd] = editRange;
  const startPct = totalDuration > 0 ? Math.max(0, Math.min(100, (selStart / totalDuration) * 100)) : 0;
  const endPct = totalDuration > 0 ? Math.max(startPct, Math.min(100, (selEnd / totalDuration) * 100)) : 100;

  const handleApplyEdit = async () => {
    stopPreview();
    try {
      const updated = await api.editCall(call.call_id, {
        mode: editMode,
        start_seconds: selStart,
        end_seconds: selEnd,
      });
      setEditing(false);
      onEdited?.(updated);
      onNotify?.(
        editMode === "keep" ? "Recording trimmed across all tracks" : "Selected segment cut from recording"
      );
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : "Failed to edit recording", "err");
      throw err;
    }
  };

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] p-3"
    >
      <audio {...audioProps} />

      <div className="group relative mb-3 select-none rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 py-2 transition-colors hover:border-[var(--ds-border-strong)]">
        {loadingWave && !waveform ? (
          <div className="flex h-16 items-center justify-center gap-2 text-xs text-[var(--ds-fg-muted)]">
            <Waves className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
            <span>Extracting waveform…</span>
          </div>
        ) : waveformError ? (
          <div className="flex h-12 items-center justify-center px-2 text-center text-xs text-[var(--ds-fg-muted)]">
            Waveform unavailable ({waveformError}) — audio controls below still work
          </div>
        ) : (
          <div className="flex items-stretch gap-2">
            {hasDual && (
              <div className="flex w-8 sm:w-9 shrink-0 flex-col justify-between py-1">
                <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-emerald-500">
                  You
                </span>
                <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-indigo-400">
                  Agent
                </span>
              </div>
            )}

            <Slider
              className="waveform-slider flex-1"
              data-dual={hasDual ? "" : undefined}
              min={0}
              max={Math.max(totalDuration, 0.01)}
              step={0.1}
              largeStep={5}
              value={displayTime}
              onValueChange={handleSliderChange}
              onValueCommit={handleSliderCommit}
              format={formatTime}
              disabled={totalDuration <= 0}
            >
              <SliderControl>
                <SliderTrack
                  className={
                    hasDual
                      ? "flex cursor-pointer flex-col gap-1.5 py-0.5 touch-none"
                      : "flex h-12 cursor-pointer items-center touch-none"
                  }
                >
                  {editing && totalDuration > 0 && (
                    <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
                      {editMode === "keep" ? (
                        <>
                          <div
                            className="absolute inset-y-0 left-0 bg-black/25 dark:bg-black/45"
                            style={{ width: `${startPct}%` }}
                          />
                          <div
                            className="absolute inset-y-0 border-x-2 border-emerald-500 bg-emerald-500/10"
                            style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
                          />
                          <div
                            className="absolute inset-y-0 right-0 bg-black/25 dark:bg-black/45"
                            style={{ width: `${100 - endPct}%` }}
                          />
                        </>
                      ) : (
                        <div
                          className="absolute inset-y-0 border-x-2 border-red-500 bg-red-500/20"
                          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
                        />
                      )}
                    </div>
                  )}

                  {hasDual ? (
                    <>
                      <WaveformBars
                        peaks={youPeaks}
                        viewHeight={28}
                        minBarHeight={3.5}
                        progress={progress}
                        align="bottom"
                        activeFill="var(--ds-you)"
                        inactiveClass="text-zinc-300 dark:text-zinc-700/80 group-hover:text-zinc-400 dark:group-hover:text-zinc-600"
                        svgClassName="block h-7 w-full overflow-visible"
                      />
                      <div className="h-px w-full bg-[var(--ds-border)]" />
                      <WaveformBars
                        peaks={agentPeaks}
                        viewHeight={28}
                        minBarHeight={3.5}
                        progress={progress}
                        align="top"
                        activeFill="var(--ds-agent)"
                        inactiveClass="text-zinc-300 dark:text-zinc-700/80 group-hover:text-zinc-400 dark:group-hover:text-zinc-600"
                        svgClassName="block h-7 w-full overflow-visible"
                      />
                    </>
                  ) : (
                    <WaveformBars
                      peaks={singlePeaks}
                      viewHeight={36}
                      minBarHeight={4}
                      progress={progress}
                      align="center"
                      activeClass="text-[var(--ds-fg)]"
                      inactiveClass="text-zinc-300 dark:text-zinc-700"
                      svgClassName="block h-10 w-full overflow-visible"
                    />
                  )}
                  <SliderThumb aria-label={`Playback position for ${displayTitle}`} />
                </SliderTrack>
              </SliderControl>
            </Slider>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Toolbar
            aria-label={`Playback controls for ${displayTitle}`}
            className="gap-1.5 border-0 bg-transparent p-0"
          >
            <ToolbarButton
              onClick={togglePlay}
              aria-label={`${playing ? "Pause" : "Play"} ${displayTitle}`}
              className="inline-flex h-10 w-10 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-lg sm:rounded-md border-0 bg-[var(--ds-btn-primary-bg)] text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)]"
              title={playing ? "Pause" : "Play"}
            >
              {playing ? (
                <Pause className="h-4 w-4 sm:h-3.5 sm:w-3.5" aria-hidden="true" />
              ) : (
                <Play className="ml-0.5 h-4 w-4 sm:h-3.5 sm:w-3.5" aria-hidden="true" />
              )}
            </ToolbarButton>

            <ToolbarButton
              onClick={() => skip(-10)}
              className="inline-flex h-9 sm:h-8 items-center gap-1 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 sm:px-2 text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
              title="Back 10 seconds"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">Back </span>
              <span>10s</span>{" "}
              <span className="sr-only">for {displayTitle}</span>
            </ToolbarButton>

            <ToolbarButton
              onClick={() => skip(10)}
              className="inline-flex h-9 sm:h-8 items-center gap-1 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 sm:px-2 text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
              title="Forward 10 seconds"
            >
              <span className="sr-only">Forward </span>
              <span>10s</span>{" "}
              <span className="sr-only">for {displayTitle}</span>
              <RotateCw className="h-3 w-3" aria-hidden="true" />
            </ToolbarButton>

            <ToolbarButton
              onClick={cycleSpeed}
              className="inline-flex h-9 sm:h-8 min-w-[44px] items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2 font-mono text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
              title="Playback speed"
            >
              {speed}x <span className="sr-only">speed for {displayTitle}</span>
            </ToolbarButton>
          </Toolbar>

          <span className="ml-auto sm:ml-1 font-mono text-xs tabular-nums text-[var(--ds-fg-secondary)]">
            {formatTime(displayTime)}{" "}
            <span className="text-[var(--ds-fg-muted)]">/ {formatTime(totalDuration)}</span>
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 sm:justify-end">
          {availableTracks.length > 0 && (
            <SegmentedControl
              aria-label={`Audio track for ${displayTitle}`}
              value={track}
              onValueChange={(v) => {
                if (v) switchTrack(v as TrackKey);
              }}
              className="flex-1 sm:flex-initial rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] p-0.5"
            >
              <SegmentedControlIndicator className="bg-[var(--ds-muted)] border-[var(--ds-border-strong)] shadow-xs" />
              {availableTracks.map((t) => (
                <SegmentedControlItem
                  key={t.key}
                  value={t.key}
                  className="flex-1 sm:flex-initial px-2.5 py-1.5 sm:py-1 text-xs sm:text-[11px] font-medium"
                >
                  {t.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          )}

          <Toolbar
            aria-label={`Audio actions for ${displayTitle}`}
            className="gap-1.5 border-0 bg-transparent p-0"
          >
            <ToolbarButton
              aria-pressed={editing}
              aria-label={`Cut or trim ${displayTitle}`}
              aria-disabled={Boolean(editBlockedReason)}
              onClick={() => {
                if (editBlockedReason) {
                  if (vmSleeping) {
                    onNotify?.("Waking the recorder VM so audio can be edited...");
                    window.location.assign(wakeUrl || "/?wake=1");
                  } else {
                    onNotify?.(editBlockedReason, "err");
                  }
                  return;
                }
                if (editing) {
                  stopPreview();
                  setEditing(false);
                } else {
                  setEditRange([0, Math.round(totalDuration * 10) / 10]);
                  setEditing(true);
                }
              }}
              className={`inline-flex h-9 sm:h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs sm:text-[11px] font-medium ${
                editing
                  ? "border-[var(--ds-fg)] bg-[var(--ds-muted)] text-[var(--ds-fg)]"
                  : editBlockedReason
                    ? "cursor-not-allowed border-dashed border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-fg-muted)] opacity-70"
                    : "border-[var(--ds-border)] bg-[var(--ds-card)] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
              }`}
              title={editBlockedReason ?? "Trim or cut audio"}
            >
              <Scissors className="h-3.5 w-3.5 sm:h-3 sm:w-3" aria-hidden="true" />
              <span>Cut</span>
            </ToolbarButton>

            <ToolbarLink
              href={`/api/calls/${encodeURIComponent(call.call_id)}/audio/${track}?download=1${versionQuery}`}
              className="inline-flex h-9 sm:h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-3 sm:px-2.5 text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] no-underline"
              title={`Download ${track} audio`}
            >
              <Download className="h-3.5 w-3.5 sm:h-3 sm:w-3" aria-hidden="true" />
              <span>
                Download <span className="sr-only">{track} audio for {displayTitle}</span>
              </span>
            </ToolbarLink>
          </Toolbar>
        </div>
      </div>

      {editing && (
        <AudioTrimPanel
          callTitle={displayTitle}
          duration={totalDuration}
          mode={editMode}
          range={editRange}
          previewing={previewActive}
          onModeChange={(next) => {
            stopPreview();
            setEditMode(next);
          }}
          onRangeChange={(next) => {
            stopPreview();
            setEditRange(next);
          }}
          onMarkStart={() => {
            stopPreview();
            const clamped = Math.round(Math.min(displayTime, Math.max(0, selEnd - 0.5)) * 10) / 10;
            setEditRange([clamped, selEnd]);
          }}
          onMarkEnd={() => {
            stopPreview();
            const clamped =
              Math.round(Math.max(displayTime, Math.min(totalDuration, selStart + 0.5)) * 10) / 10;
            setEditRange([selStart, clamped]);
          }}
          onTogglePreview={() => {
            if (previewActive) {
              stopPreview();
            } else {
              void startPreview(editMode, selStart, selEnd);
            }
          }}
          onApply={handleApplyEdit}
          onCancel={() => {
            stopPreview();
            setEditing(false);
          }}
        />
      )}

      {audioError && <p className="mt-2 text-xs text-red-500">{audioError}</p>}
    </div>
  );
};
