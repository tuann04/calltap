import React from "react";
import { CheckSquare, Loader2, Search, Trash2, Upload, X } from "lucide-react";
import { Button } from "@ui-sdk/react/button";
import { Input, InputClear, InputGroup } from "@ui-sdk/react/input";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { Toolbar, ToolbarButton } from "@ui-sdk/react/toolbar";
import type { CallMetadata } from "../types";

interface LibraryToolbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  serviceOptions: string[];
  serviceFilter: string;
  onServiceFilterChange: (svc: string) => void;
  totalCallsCount: number;
  selectableCount: number;
  allFilteredSelected: boolean;
  onToggleSelectAll: () => void;
  cloudConnected: boolean;
  pendingUploads: number;
  bulkUploading: boolean;
  onUploadAllPending: () => void;
  selectedCalls: CallMetadata[];
  onBulkUploadSelected: () => void;
  onBulkDeleteSelected: () => void;
  onClearSelection: () => void;
}

export const LibraryToolbar: React.FC<LibraryToolbarProps> = ({
  searchQuery,
  onSearchChange,
  serviceOptions,
  serviceFilter,
  onServiceFilterChange,
  totalCallsCount,
  selectableCount,
  allFilteredSelected,
  onToggleSelectAll,
  cloudConnected,
  pendingUploads,
  bulkUploading,
  onUploadAllPending,
  selectedCalls,
  onBulkUploadSelected,
  onBulkDeleteSelected,
  onClearSelection,
}) => (
  <>
    <section className="space-y-3">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <InputGroup
          aria-label="Search filter"
          className="h-11 sm:h-9 flex-1 border-[var(--ds-border)] bg-[var(--ds-card)] sm:max-w-md"
        >
          <Search
            className="ml-3 h-4 w-4 shrink-0 text-[var(--ds-fg-muted)] sm:h-3.5 sm:w-3.5"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search recordings"
            value={searchQuery}
            onValueChange={onSearchChange}
            placeholder="Search title, service, notes, or #tag…"
            className="h-full border-0 bg-transparent px-2.5 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)]"
          />
          <InputClear
            aria-label="Clear search"
            className="mr-1.5 inline-flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent text-[var(--ds-fg-muted)] hover:bg-[var(--ds-muted)] hover:text-[var(--ds-fg)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </InputClear>
        </InputGroup>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={onToggleSelectAll}
            disabled={selectableCount === 0}
            className="inline-flex h-9 sm:h-8 items-center gap-1.5 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-3 sm:px-2.5 text-xs text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
          >
            <CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {allFilteredSelected ? "Deselect all recordings" : "Select all recordings"}
            </span>
          </Button>

          {cloudConnected && pendingUploads > 0 && (
            <Button
              type="button"
              disabled={bulkUploading}
              onClick={onUploadAllPending}
              className="inline-flex h-9 sm:h-8 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-500 hover:bg-emerald-500/15"
            >
              {bulkUploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>Upload pending ({pendingUploads})</span>
            </Button>
          )}
        </div>
      </div>

      <div className="no-scrollbar -mx-3 overflow-x-auto px-3 pb-0.5 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
        <SegmentedControl
          aria-label="Filter by provider"
          value={serviceFilter}
          onValueChange={(next) => {
            if (next) onServiceFilterChange(next);
          }}
          className="rounded-lg border-[var(--ds-border)] bg-[var(--ds-surface)] p-0.5"
        >
          <SegmentedControlIndicator className="rounded-md border-[var(--ds-fg)] bg-[var(--ds-btn-primary-bg)]" />
          {serviceOptions.map((svc) => (
            <SegmentedControlItem
              key={svc}
              value={svc}
              className="flex-none px-3 py-1.5 sm:py-1 text-xs font-medium text-[var(--ds-fg-secondary)] data-checked:text-[var(--ds-btn-primary-fg)]"
            >
              {svc === "all" ? `All (${totalCallsCount})` : svc}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
    </section>

    {selectedCalls.length > 0 && (
      <Toolbar
        aria-label="Selected recordings actions"
        className="fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-30 flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-[var(--ds-fg)]/40 bg-[var(--ds-card)]/95 px-3.5 py-3 shadow-2xl backdrop-blur-md sm:sticky sm:top-16 sm:inset-x-auto sm:z-20 sm:w-full sm:rounded-xl sm:px-4 sm:py-2.5 sm:shadow-lg"
      >
        <span className="text-xs font-medium text-[var(--ds-fg)]">
          {selectedCalls.length} selected
        </span>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <ToolbarButton
            disabled={bulkUploading}
            onClick={onBulkUploadSelected}
            className="inline-flex h-9 sm:h-8 items-center gap-1.5 rounded-md border-0 bg-[var(--ds-btn-primary-bg)] px-3 text-xs font-medium text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)]"
          >
            {bulkUploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>Upload selected</span>
          </ToolbarButton>

          <ToolbarButton
            onClick={onBulkDeleteSelected}
            className="inline-flex h-9 sm:h-8 items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 text-xs font-medium text-red-400 hover:bg-red-500/20"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Delete selected</span>
          </ToolbarButton>

          <ToolbarButton
            onClick={onClearSelection}
            className="inline-flex h-9 sm:h-8 items-center rounded-md border border-[var(--ds-border)] bg-transparent px-2.5 text-xs text-[var(--ds-fg-secondary)] hover:text-[var(--ds-fg)]"
          >
            Clear selection
          </ToolbarButton>
        </div>
      </Toolbar>
    )}
  </>
);
