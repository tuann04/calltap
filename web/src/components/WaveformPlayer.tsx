import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, RotateCcw, RotateCw, Waves } from "lucide-react";
import { api } from "../api";
import type { CallMetadata, WaveformResponse } from "../types";

interface WaveformPlayerProps {
  call: CallMetadata;
}

type TrackKey = "mix" | "you" | "agent";

function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const WaveformPlayer: React.FC<WaveformPlayerProps> = ({ call }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pendingSeekRef = useRef<{ time: number; autoPlay: boolean } | null>(null);

  const availableTracks = useMemo(() => {
    const list: { key: TrackKey; label: string; file: string }[] = [];
    if (call.files.mix) list.push({ key: "mix", label: "Mix", file: call.files.mix });
    if (call.files.you) list.push({ key: "you", label: "You", file: call.files.you });
    if (call.files.agent) list.push({ key: "agent", label: "Agent", file: call.files.agent });
    return list;
  }, [call.files]);

  const [track, setTrack] = useState<TrackKey>(call.files.mix ? "mix" : "you");
  const [isVisible, setIsVisible] = useState(false);
  const [waveform, setWaveform] = useState<WaveformResponse | null>(null);
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [loadingWave, setLoadingWave] = useState(false);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(call.duration_seconds ?? 0);
  const [speed, setSpeed] = useState<number>(1);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  useEffect(() => {
    if (!availableTracks.some((t) => t.key === track) && availableTracks.length > 0) {
      setTrack(availableTracks[0].key);
    }
  }, [availableTracks, track]);

  useEffect(() => {
    if (call.duration_seconds && (!duration || !Number.isFinite(duration))) {
      setDuration(call.duration_seconds);
    }
  }, [call.duration_seconds, duration]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setIsVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible || call.status !== "completed" || call.local_pruned) return;
    let cancelled = false;
    setLoadingWave(true);
    setWaveformError(null);
    api
      .getWaveform(call.call_id)
      .then((data) => {
        if (cancelled) return;
        setWaveform(data);
        if (data.duration_seconds > 0) {
          setDuration((prev) => (prev > 0 ? prev : data.duration_seconds));
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setWaveformError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingWave(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isVisible, call.call_id, call.status, call.local_pruned]);

  const audioSrc = `/api/calls/${encodeURIComponent(call.call_id)}/audio/${track}`;

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    setAudioError(null);
    if (playing) {
      audio.pause();
    } else {
      try {
        await audio.play();
      } catch (err) {
        setAudioError(err instanceof Error ? err.message : "Playback failed");
      }
    }
  };

  const skip = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
    const next = Math.max(0, Math.min(total || 0, audio.currentTime + delta));
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const switchTrack = (nextTrack: TrackKey) => {
    if (nextTrack === track) return;
    const audio = audioRef.current;
    if (audio) {
      pendingSeekRef.current = {
        time: audio.currentTime || currentTime,
        autoPlay: playing,
      };
      audio.pause();
    }
    setAudioError(null);
    setTrack(nextTrack);
  };

  const cycleSpeed = () => {
    const rates = [1, 1.25, 1.5, 2, 0.75];
    const next = rates[(rates.indexOf(speed) + 1) % rates.length];
    setSpeed(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
    }
  };

  const seekFromClientX = (clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    const audio = audioRef.current;
    if (!box || box.width <= 0) return;
    const total =
      audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
    if (!total || total <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    const target = ratio * total;
    setCurrentTime(target);
    if (audio) {
      audio.currentTime = target;
    }
  };

  useEffect(() => {
    if (!isScrubbing) return;
    const onMove = (e: PointerEvent) => seekFromClientX(e.clientX);
    const onUp = () => setIsScrubbing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  });

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

  if (call.local_pruned) {
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

  const totalDuration = duration || waveform?.duration_seconds || 0;
  const progress = totalDuration > 0 ? Math.min(1, Math.max(0, currentTime / totalDuration)) : 0;

  const youPeaks = waveform?.tracks.you ?? [];
  const agentPeaks = waveform?.tracks.agent ?? [];
  const mixPeaks = waveform?.tracks.mix ?? [];
  const hasDual = youPeaks.length > 0 && agentPeaks.length > 0;
  const fallbackPeaks = mixPeaks.length > 0 ? mixPeaks : youPeaks.length > 0 ? youPeaks : agentPeaks;
  const bins = (hasDual ? youPeaks.length : fallbackPeaks.length) || 96;

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] p-3"
    >
      <audio
        ref={audioRef}
        src={audioSrc}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          if (!isScrubbing) {
            setCurrentTime(e.currentTarget.currentTime);
          }
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (Number.isFinite(el.duration) && el.duration > 0) {
            setDuration(el.duration);
          }
          el.playbackRate = speed;
          if (pendingSeekRef.current) {
            const { time, autoPlay } = pendingSeekRef.current;
            pendingSeekRef.current = null;
            el.currentTime = Math.min(time, el.duration || time);
            if (autoPlay) {
              el.play().catch(() => {});
            }
          }
        }}
        onError={() => {
          setPlaying(false);
          setAudioError("Track unavailable or unsupported by this browser.");
        }}
      />

      {/* Interactive Dual-Track Waveform */}
      <div
        className="group relative mb-3 select-none rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 py-2 transition-colors hover:border-[var(--ds-border-strong)]"
      >
        {loadingWave && !waveform ? (
          <div className="flex h-16 items-center justify-center gap-2 text-xs text-[var(--ds-fg-muted)]">
            <Waves className="h-3.5 w-3.5 animate-pulse" />
            <span>Extracting waveform…</span>
          </div>
        ) : waveformError ? (
          <div className="flex h-12 items-center justify-center px-2 text-center text-xs text-[var(--ds-fg-muted)]">
            Waveform unavailable ({waveformError}) — audio controls below still work
          </div>
        ) : hasDual ? (
          <div className="flex items-stretch gap-2">
            {/* Labels column */}
            <div className="flex w-8 sm:w-9 shrink-0 flex-col justify-between py-1">
              <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-emerald-500">
                You
              </span>
              <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-indigo-400">
                Agent
              </span>
            </div>

            {/* Scrubbable SVG bars + playhead */}
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
              className="relative flex flex-1 cursor-pointer flex-col gap-1.5 py-0.5 touch-none"
            >
              <svg
                viewBox={`0 0 ${youPeaks.length * 4} 28`}
                preserveAspectRatio="none"
                className="block h-7 w-full overflow-visible"
                aria-hidden
              >
                {youPeaks.map((amp, i) => {
                  const pct = (i + 0.5) / youPeaks.length;
                  const active = pct <= progress;
                  const h = Math.max(3.5, Math.round(amp * 280) / 10);
                  return (
                    <rect
                      key={i}
                      x={i * 4 + 0.6}
                      y={28 - h}
                      width={2.8}
                      height={h}
                      rx={0.8}
                      fill={active ? "var(--ds-you)" : "currentColor"}
                      className={
                        active
                          ? ""
                          : "text-zinc-300 dark:text-zinc-700/80 group-hover:text-zinc-400 dark:group-hover:text-zinc-600"
                      }
                    />
                  );
                })}
              </svg>

              <div className="h-px w-full bg-[var(--ds-border)]" />

              <svg
                viewBox={`0 0 ${agentPeaks.length * 4} 28`}
                preserveAspectRatio="none"
                className="block h-7 w-full overflow-visible"
                aria-hidden
              >
                {agentPeaks.map((amp, i) => {
                  const pct = (i + 0.5) / agentPeaks.length;
                  const active = pct <= progress;
                  const h = Math.max(3.5, Math.round(amp * 280) / 10);
                  return (
                    <rect
                      key={i}
                      x={i * 4 + 0.6}
                      y={0}
                      width={2.8}
                      height={h}
                      rx={0.8}
                      fill={active ? "var(--ds-agent)" : "currentColor"}
                      className={
                        active
                          ? ""
                          : "text-zinc-300 dark:text-zinc-700/80 group-hover:text-zinc-400 dark:group-hover:text-zinc-600"
                      }
                    />
                  );
                })}
              </svg>

              {totalDuration > 0 && (
                <div
                  aria-hidden
                  style={{ left: `${progress * 100}%` }}
                  className="pointer-events-none absolute top-0 bottom-0 w-[1.5px] -translate-x-1/2 bg-[var(--ds-fg)] shadow-[0_0_6px_rgba(255,255,255,0.4)]"
                />
              )}
            </div>
          </div>
        ) : (
          <div
            ref={trackRef}
            role="slider"
            aria-label="Audio playback position"
            aria-valuemin={0}
            aria-valuemax={Math.round(totalDuration)}
            aria-valuenow={Math.round(currentTime)}
            tabIndex={0}
            onPointerDown={(e) => {
              setIsScrubbing(true);
              seekFromClientX(e.clientX);
            }}
            className="relative flex h-12 cursor-pointer items-center touch-none"
          >
            <svg
              viewBox={`0 0 ${bins * 4} 36`}
              preserveAspectRatio="none"
              className="block h-10 w-full overflow-visible"
              aria-hidden
            >
              {(fallbackPeaks.length > 0 ? fallbackPeaks : Array.from({ length: bins }, () => 0.15)).map(
                (amp, i) => {
                  const pct = (i + 0.5) / bins;
                  const active = pct <= progress;
                  const h = Math.max(4, Math.round(amp * 360) / 10);
                  return (
                    <rect
                      key={i}
                      x={i * 4 + 0.6}
                      y={(36 - h) / 2}
                      width={2.8}
                      height={h}
                      rx={0.8}
                      fill="currentColor"
                      className={
                        active ? "text-[var(--ds-fg)]" : "text-zinc-300 dark:text-zinc-700"
                      }
                    />
                  );
                }
              )}
            </svg>
            {totalDuration > 0 && (
              <div
                aria-hidden
                style={{ left: `${progress * 100}%` }}
                className="pointer-events-none absolute top-0 bottom-0 w-[1.5px] -translate-x-1/2 bg-[var(--ds-fg)]"
              />
            )}
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
            {playing ? <Pause className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> : <Play className="h-4 w-4 sm:h-3.5 sm:w-3.5 ml-0.5" />}
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
          {/* Segmented track switcher */}
          <div className="inline-flex flex-1 sm:flex-initial rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] p-0.5">
            {availableTracks.map((t) => {
              const active = t.key === track;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => switchTrack(t.key)}
                  className={`flex-1 sm:flex-initial rounded px-2.5 py-1.5 sm:py-1 text-xs sm:text-[11px] font-medium transition cursor-pointer ${
                    active
                      ? "bg-[var(--ds-muted)] text-[var(--ds-fg)] shadow-xs"
                      : "text-[var(--ds-fg-muted)] hover:text-[var(--ds-fg)]"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Direct Download */}
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
