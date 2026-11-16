import React from "react";
import { CheckSquare, Loader2, Search, Trash2, Upload } from "lucide-react";
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
        <div className="relative flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 sm:h-3.5 sm:w-3.5 -translate-y-1/2 text-[var(--ds-fg-muted)]" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search title, service, notes, or #tag…"
            className="h-11 sm:h-9 w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] pl-9 pr-3 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onToggleSelectAll}
            disabled={selectableCount === 0}
            className="inline-flex h-9 sm:h-8 items-center gap-1.5 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-3 sm:px-2.5 text-xs text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] disabled:opacity-40 cursor-pointer"
          >
            <CheckSquare className="h-3.5 w-3.5" />
            <span>{allFilteredSelected ? "Deselect All" : "Select All"}</span>
          </button>

          {cloudConnected && pendingUploads > 0 && (
            <button
              type="button"
              disabled={bulkUploading}
              onClick={onUploadAllPending}
              className="inline-flex h-9 sm:h-8 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-500 hover:bg-emerald-500/15 disabled:opacity-50 cursor-pointer"
            >
              {bulkUploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              <span>Upload Pending ({pendingUploads})</span>
            </button>
          )}
        </div>
      </div>

      <div className="no-scrollbar -mx-3 flex items-center gap-1.5 overflow-x-auto px-3 pb-0.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
        {serviceOptions.map((svc) => {
          const active = serviceFilter === svc;
          return (
            <button
              key={svc}
              type="button"
              onClick={() => onServiceFilterChange(svc)}
              className={`shrink-0 rounded-full border px-3.5 py-1.5 sm:px-3 sm:py-1 text-xs font-medium transition cursor-pointer ${
                active
                  ? "border-[var(--ds-fg)] bg-[var(--ds-btn-primary-bg)] text-[var(--ds-btn-primary-fg)]"
                  : "border-[var(--ds-border)] bg-[var(--ds-card)] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
              }`}
            >
              {svc === "all" ? `All (${totalCallsCount})` : svc}
            </button>
          );
        })}
      </div>
    </section>

    {selectedCalls.length > 0 && (
      <div className="fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-30 flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-[var(--ds-fg)]/40 bg-[var(--ds-card)]/95 px-3.5 py-3 shadow-2xl backdrop-blur-md sm:sticky sm:top-16 sm:inset-x-auto sm:z-20 sm:rounded-xl sm:px-4 sm:py-2.5 sm:shadow-lg">
        <span className="text-xs font-medium text-[var(--ds-fg)]">
          {selectedCalls.length} selected
        </span>
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            disabled={bulkUploading}
            onClick={onBulkUploadSelected}
            className="inline-flex h-9 sm:h-8 items-center gap-1.5 rounded-md bg-[var(--ds-btn-primary-bg)] px-3 text-xs font-medium text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)] disabled:opacity-50 cursor-pointer"
          >
            {bulkUploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            <span>Upload</span>
          </button>

          <button
            type="button"
            onClick={onBulkDeleteSelected}
            className="inline-flex h-9 sm:h-8 items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 text-xs font-medium text-red-400 hover:bg-red-500/20 cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Delete</span>
          </button>

          <button
            type="button"
            onClick={onClearSelection}
            className="inline-flex h-9 sm:h-8 items-center rounded-md border border-[var(--ds-border)] px-2.5 text-xs text-[var(--ds-fg-secondary)] hover:text-[var(--ds-fg)] cursor-pointer"
          >
            Clear
          </button>
        </div>
      </div>
    )}
  </>
);
