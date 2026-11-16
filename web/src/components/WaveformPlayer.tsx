import React from "react";
import { Download, Pause, Play, RotateCcw, RotateCw, Waves } from "lucide-react";
import { useWaveformAudio } from "../hooks/useWaveformAudio";
import type { CallMetadata } from "../types";
import { formatTime } from "../utils/callDisplay";

interface WaveformPlayerProps {
  call: CallMetadata;
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
    aria-hidden
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

export const WaveformPlayer: React.FC<WaveformPlayerProps> = ({ call }) => {
  const {
    containerRef,
    trackRef,
    audioProps,
    availableTracks,
    track,
    waveform,
    waveformError,
    loadingWave,
    playing,
    currentTime,
    totalDuration,
    progress,
    speed,
    audioError,
    isUnplayablePruned,
    setIsScrubbing,
    seekFromClientX,
    togglePlay,
    skip,
    switchTrack,
    cycleSpeed,
  } = useWaveformAudio(call);

  if (call.status !== "completed") {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-between rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3.5 py-3 text-xs text-[var(--ds-fg-secondary)]"
      >
        <div className="flex items-center gap-2">
          <Waves className="h-3.5 w-3.5 animate-pulse text-red-500" />
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

  const youPeaks = waveform?.tracks.you ?? [];
  const agentPeaks = waveform?.tracks.agent ?? [];
  const mixPeaks = waveform?.tracks.mix ?? [];
  const hasDual = youPeaks.length > 0 && agentPeaks.length > 0;
  const fallbackPeaks = mixPeaks.length > 0 ? mixPeaks : youPeaks.length > 0 ? youPeaks : agentPeaks;
  const singlePeaks =
    fallbackPeaks.length > 0 ? fallbackPeaks : Array.from({ length: 96 }, () => 0.15);

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] p-3"
    >
      <audio {...audioProps} />

      <div className="group relative mb-3 select-none rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 py-2 transition-colors hover:border-[var(--ds-border-strong)]">
        {loadingWave && !waveform ? (
          <div className="flex h-16 items-center justify-center gap-2 text-xs text-[var(--ds-fg-muted)]">
            <Waves className="h-3.5 w-3.5 animate-pulse" />
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

            <div
              ref={trackRef}
              role="slider"
              aria-label="Audio playback position"
              aria-valuemin={0}
              aria-valuemax={Math.round(totalDuration)}
              aria-valuenow={Math.round(currentTime)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  skip(-5);
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  skip(5);
                } else if (e.key === " ") {
                  e.preventDefault();
                  togglePlay();
                }
              }}
              onPointerDown={(e) => {
                setIsScrubbing(true);
                seekFromClientX(e.clientX);
              }}
              className={
                hasDual
                  ? "relative flex flex-1 cursor-pointer flex-col gap-1.5 py-0.5 touch-none"
                  : "relative flex h-12 flex-1 cursor-pointer items-center touch-none"
              }
            >
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

              {totalDuration > 0 && (
                <div
                  aria-hidden
                  style={{ left: `${progress * 100}%` }}
                  className={`pointer-events-none absolute top-0 bottom-0 w-[1.5px] -translate-x-1/2 bg-[var(--ds-fg)] ${
                    hasDual ? "shadow-[0_0_6px_rgba(255,255,255,0.4)]" : ""
                  }`}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Transport & Track Controls */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={togglePlay}
            className="inline-flex h-10 w-10 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-lg sm:rounded-md bg-[var(--ds-btn-primary-bg)] text-[var(--ds-btn-primary-fg)] transition hover:bg-[var(--ds-btn-primary-hover)] cursor-pointer"
            title={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
            ) : (
              <Play className="h-4 w-4 sm:h-3.5 sm:w-3.5 ml-0.5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => skip(-10)}
            className="inline-flex h-9 sm:h-8 items-center gap-1 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 sm:px-2 text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] cursor-pointer"
            title="Back 10 seconds"
          >
            <RotateCcw className="h-3 w-3" />
            <span>10s</span>
          </button>

          <button
            type="button"
            onClick={() => skip(10)}
            className="inline-flex h-9 sm:h-8 items-center gap-1 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 sm:px-2 text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] cursor-pointer"
            title="Forward 10 seconds"
          >
            <span>10s</span>
            <RotateCw className="h-3 w-3" />
          </button>

          <button
            type="button"
            onClick={cycleSpeed}
            className="inline-flex h-9 sm:h-8 min-w-[44px] items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2 font-mono text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] cursor-pointer"
            title="Playback speed"
          >
            {speed}x
          </button>

          <span className="ml-auto sm:ml-1 font-mono text-xs tabular-nums text-[var(--ds-fg-secondary)]">
            {formatTime(currentTime)}{" "}
            <span className="text-[var(--ds-fg-muted)]">/ {formatTime(totalDuration)}</span>
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <div className="inline-flex flex-1 sm:flex-initial rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] p-0.5">
            {availableTracks.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => switchTrack(t.key)}
                className={`flex-1 sm:flex-initial rounded px-2.5 py-1.5 sm:py-1 text-xs sm:text-[11px] font-medium transition cursor-pointer ${
                  t.key === track
                    ? "bg-[var(--ds-muted)] text-[var(--ds-fg)] shadow-xs"
                    : "text-[var(--ds-fg-muted)] hover:text-[var(--ds-fg)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <a
            href={`/api/calls/${encodeURIComponent(call.call_id)}/audio/${track}?download=1`}
            className="inline-flex h-9 sm:h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-3 sm:px-2.5 text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] no-underline"
            title={`Download ${track} audio`}
          >
            <Download className="h-3.5 w-3.5 sm:h-3 sm:w-3" />
            <span>Download</span>
          </a>
        </div>
      </div>

      {audioError && <p className="mt-2 text-xs text-red-500">{audioError}</p>}
    </div>
  );
};
