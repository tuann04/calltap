import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../api";
import type { CallMetadata } from "../types";

interface CallNotesDrawerProps {
  call: CallMetadata;
  onUpdated: (updated: CallMetadata) => void;
  onNotify: (msg: string, tone?: "ok" | "err") => void;
}

export const CallNotesDrawer: React.FC<CallNotesDrawerProps> = ({
  call,
  onUpdated,
  onNotify,
}) => {
  const [notesDraft, setNotesDraft] = useState(call.notes);
  const [tagsDraft, setTagsDraft] = useState(call.tags.join(", "));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNotesDraft(call.notes);
    setTagsDraft(call.tags.join(", "));
  }, [call.notes, call.tags]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const parsedTags = tagsDraft
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await api.patchCall(call.call_id, {
        notes: notesDraft,
        tags: parsedTags,
      });
      onUpdated(updated);
      onNotify("Saved notes & tags");
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Failed to update notes", "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-3 space-y-2.5 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] p-3"
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-[var(--ds-fg-secondary)]">
            Tags (comma separated)
          </label>
          <input
            type="text"
            value={tagsDraft}
            onChange={(e) => setTagsDraft(e.target.value)}
            placeholder="english, interview, daily"
            className="h-10 sm:h-auto w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 py-1.5 text-xs text-[var(--ds-fg)] focus:border-[var(--ds-fg)] focus:outline-none"
          />
        </div>
        <div className="min-w-0">
          <label className="mb-1 block text-[11px] font-medium text-[var(--ds-fg-secondary)]">
            Remote Location
          </label>
          <div className="truncate rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 py-2 sm:py-1.5 font-mono text-[11px] text-[var(--ds-fg-muted)]">
            {call.remote_uri ?? "Not uploaded"}
          </div>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-[var(--ds-fg-secondary)]">
          Notes
        </label>
        <textarea
          rows={2}
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          placeholder="Add observations, topics discussed, follow-ups…"
          className="w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 py-2 sm:py-1.5 text-xs text-[var(--ds-fg)] focus:border-[var(--ds-fg)] focus:outline-none"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-[var(--ds-fg-muted)]">
          ID: {call.call_id}
        </span>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-9 sm:h-7 shrink-0 items-center gap-1.5 rounded-md bg-[var(--ds-btn-primary-bg)] px-3.5 sm:px-3 text-xs font-medium text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)] disabled:opacity-50 cursor-pointer"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          <span>Save Details</span>
        </button>
      </div>
    </form>
  );
};
