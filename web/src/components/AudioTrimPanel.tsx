import React from "react";
import { Loader2, Play, Scissors, Square } from "lucide-react";
import { Button } from "@ui-sdk/react/button";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  Slider,
  SliderControl,
  SliderIndicator,
  SliderThumb,
  SliderTrack,
} from "@ui-sdk/react/slider";
import type { AudioEditMode } from "../types";
import { formatTime } from "../utils/callDisplay";

interface AudioTrimPanelProps {
  callTitle: string;
  duration: number;
  mode: AudioEditMode;
  range: [number, number];
  previewing: boolean;
  onModeChange: (mode: AudioEditMode) => void;
  onRangeChange: (next: [number, number]) => void;
  onMarkStart: () => void;
  onMarkEnd: () => void;
  onTogglePreview: () => void;
  onApply: () => Promise<void>;
  onCancel: () => void;
}

export const AudioTrimPanel: React.FC<AudioTrimPanelProps> = ({
  callTitle,
  duration,
  mode,
  range,
  previewing,
  onModeChange,
  onRangeChange,
  onMarkStart,
  onMarkEnd,
  onTogglePreview,
  onApply,
  onCancel,
}) => {
  const [start, end] = range;
  const span = Math.max(0, end - start);
  const resultingDuration = mode === "keep" ? span : Math.max(0, duration - span);
  const fullSpanSelected = start <= 0.05 && end >= Math.max(0, duration - 0.05);
  const canApply =
    duration > 0.5 &&
    !fullSpanSelected &&
    (mode === "keep" ? span >= 0.5 : span >= 0.1 && resultingDuration >= 0.5);

  return (
    <div className="mt-3 space-y-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          aria-label={`Edit mode for ${callTitle}`}
          value={mode}
          onValueChange={(next) => {
            if (next === "keep" || next === "cut") onModeChange(next);
          }}
          className="rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] p-0.5"
        >
          <SegmentedControlIndicator className="rounded bg-[var(--ds-muted)] border-[var(--ds-border-strong)]" />
          <SegmentedControlItem value="keep" className="px-2.5 py-1 text-xs font-medium">
            Keep range
          </SegmentedControlItem>
          <SegmentedControlItem value="cut" className="px-2.5 py-1 text-xs font-medium">
            Cut range
          </SegmentedControlItem>
        </SegmentedControl>

        <div className="font-mono text-[11px] tabular-nums text-[var(--ds-fg-secondary)]">
          <span>
            {formatTime(start)} – {formatTime(end)}
          </span>
          <span className="mx-1.5 text-[var(--ds-border-strong)]">·</span>
          <span className={mode === "cut" ? "text-red-400" : "text-emerald-500"}>
            {mode === "keep"
              ? `Keeps ${formatTime(resultingDuration)}`
              : `Removes ${formatTime(span)} · Leaves ${formatTime(resultingDuration)}`}
          </span>
        </div>
      </div>

      <Slider<number[]>
        aria-label={`Selection range for ${callTitle}`}
        min={0}
        max={Math.max(duration, 0.5)}
        step={0.1}
        largeStep={5}
        minStepsBetweenThumbs={5}
        value={range}
        onValueChange={(next) => {
          if (Array.isArray(next) && next.length === 2) {
            onRangeChange([next[0], next[1]]);
          }
        }}
        format={formatTime}
        className="py-1"
      >
        <SliderControl className="h-6 cursor-pointer touch-none">
          <SliderTrack className="h-2 rounded-full bg-[var(--ds-muted)]">
            <SliderIndicator
              className={`rounded-full ${mode === "cut" ? "bg-red-500" : "bg-emerald-500"}`}
            />
            <SliderThumb
              index={0}
              aria-label={`Selection start for ${callTitle}`}
              className="h-4 w-4 rounded-full border-2 border-[var(--ds-card)] bg-[var(--ds-fg)] shadow"
            />
            <SliderThumb
              index={1}
              aria-label={`Selection end for ${callTitle}`}
              className="h-4 w-4 rounded-full border-2 border-[var(--ds-card)] bg-[var(--ds-fg)] shadow"
            />
          </SliderTrack>
        </SliderControl>
      </Slider>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            onClick={onMarkStart}
            aria-label={`Set start to playhead for ${callTitle}`}
            className="inline-flex h-8 sm:h-7 items-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2.5 text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
            title="Move selection start to current playhead"
          >
            Set Start
          </Button>
          <Button
            type="button"
            onClick={onMarkEnd}
            aria-label={`Set end to playhead for ${callTitle}`}
            className="inline-flex h-8 sm:h-7 items-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2.5 text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
            title="Move selection end to current playhead"
          >
            Set End
          </Button>
          <Button
            type="button"
            onClick={onTogglePreview}
            aria-label={`${previewing ? "Stop preview" : "Preview edit"} for ${callTitle}`}
            className="inline-flex h-8 sm:h-7 items-center gap-1 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2.5 text-xs sm:text-[11px] font-medium text-[var(--ds-fg)] hover:border-[var(--ds-border-strong)]"
            title={
              mode === "keep"
                ? "Play selected segment"
                : "Play across the cut point to hear the splice"
            }
          >
            {previewing ? (
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
            ) : (
              <Play className="h-3 w-3" aria-hidden="true" />
            )}
            <span>{previewing ? "Stop" : "Preview"}</span>
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={onCancel}
            aria-label={`Cancel editing ${callTitle}`}
            className="inline-flex h-8 sm:h-7 items-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2.5 text-xs sm:text-[11px] font-medium text-[var(--ds-fg-secondary)] hover:text-[var(--ds-fg)]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-variant="solid"
            disabled={!canApply}
            pendingAnnouncement={`Applying ${mode === "keep" ? "trim" : "cut"} to ${callTitle}`}
            data-agent-confirm={`Permanently ${mode === "keep" ? "trims" : "cuts"} the recording audio tracks`}
            onClick={onApply}
            className={`inline-flex h-8 sm:h-7 items-center gap-1.5 rounded-md border-0 px-3 text-xs sm:text-[11px] font-semibold ${
              mode === "cut"
                ? "bg-red-600 text-white hover:bg-red-500"
                : "bg-[var(--ds-btn-primary-bg)] text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)]"
            }`}
          >
            <Scissors className="h-3 w-3" data-show="idle" aria-hidden="true" />
            <Loader2 className="h-3 w-3 animate-spin" data-show="pending" aria-hidden="true" />
            <span data-show="idle">
              {mode === "keep" ? "Apply Trim" : "Apply Cut"}{" "}
              <span className="sr-only">to {callTitle}</span>
            </span>
            <span data-show="pending" aria-hidden="true">
              Applying…
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
};
