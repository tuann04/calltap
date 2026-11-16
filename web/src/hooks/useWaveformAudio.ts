import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SliderValueChangeReason } from "@ui-sdk/react/slider";
import { api } from "../api";
import type { CallMetadata, WaveformResponse } from "../types";

export type TrackKey = "mix" | "you" | "agent";

const PLAYBACK_RATES = [1, 1.25, 1.5, 2, 0.75];

export function useWaveformAudio(call: CallMetadata) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = useRef<{ time: number; autoPlay: boolean } | null>(null);
  const scrubbingRef = useRef(false);

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
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [duration, setDuration] = useState<number>(call.duration_seconds ?? 0);
  const [speed, setSpeed] = useState<number>(1);
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

  const isUnplayablePruned = call.local_pruned && call.upload_status !== "uploaded";

  useEffect(() => {
    if (!isVisible || call.status !== "completed" || isUnplayablePruned) return;
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
  }, [isVisible, call.call_id, call.status, isUnplayablePruned]);

  const togglePlay = useCallback(async () => {
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
  }, [playing]);

  const seekTo = useCallback(
    (target: number) => {
      const audio = audioRef.current;
      const total =
        audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
      const clamped = Math.max(0, Math.min(total || target, target));
      setCurrentTime(clamped);
      if (audio) {
        audio.currentTime = clamped;
      }
    },
    [duration]
  );

  const skip = useCallback(
    (delta: number) => {
      const base = audioRef.current?.currentTime ?? currentTime;
      seekTo(base + delta);
    },
    [currentTime, seekTo]
  );

  const handleSliderChange = useCallback(
    (next: number, details: { reason: SliderValueChangeReason }) => {
      if (details.reason === "drag") {
        scrubbingRef.current = true;
        setScrubTime(next);
        return;
      }
      scrubbingRef.current = false;
      setScrubTime(null);
      seekTo(next);
    },
    [seekTo]
  );

  const handleSliderCommit = useCallback(
    (next: number) => {
      scrubbingRef.current = false;
      setScrubTime(null);
      seekTo(next);
    },
    [seekTo]
  );

  const switchTrack = useCallback(
    (nextTrack: TrackKey) => {
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
    },
    [track, currentTime, playing]
  );

  const cycleSpeed = useCallback(() => {
    const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(speed) + 1) % PLAYBACK_RATES.length];
    setSpeed(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
    }
  }, [speed]);

  const audioProps = {
    ref: audioRef,
    src: `/api/calls/${encodeURIComponent(call.call_id)}/audio/${track}`,
    preload: "metadata" as const,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLAudioElement>) => {
      if (!scrubbingRef.current) {
        setCurrentTime(e.currentTarget.currentTime);
      }
    },
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLAudioElement>) => {
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
    },
    onError: () => {
      setPlaying(false);
      setAudioError("Track unavailable or unsupported by this browser.");
    },
  };

  const totalDuration = duration || waveform?.duration_seconds || 0;
  const displayTime = scrubTime ?? currentTime;
  const progress = totalDuration > 0 ? Math.min(1, Math.max(0, displayTime / totalDuration)) : 0;

  return {
    containerRef,
    audioProps,
    availableTracks,
    track,
    waveform,
    waveformError,
    loadingWave,
    playing,
    displayTime,
    totalDuration,
    progress,
    speed,
    audioError,
    isUnplayablePruned,
    handleSliderChange,
    handleSliderCommit,
    togglePlay,
    skip,
    switchTrack,
    cycleSpeed,
  };
}
