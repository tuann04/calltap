import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Textarea } from "@ui-sdk/react/textarea";
import { api } from "../api";
import type { CallMetadata } from "../types";
import { formatCallTitle } from "../utils/callDisplay";
import type { NotifyFn } from "./AppToastRegion";

interface CallNotesDrawerProps {
  call: CallMetadata;
  onUpdated: (updated: CallMetadata) => void;
  onNotify: NotifyFn;
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

  const displayTitle = formatCallTitle(call);

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
        <Field>
          <FieldLabel className="text-[11px] font-medium text-[var(--ds-fg-secondary)]">
            Tags (comma separated) <span className="sr-only">for {displayTitle}</span>
          </FieldLabel>
          <Input
            type="text"
            value={tagsDraft}
            onValueChange={setTagsDraft}
            placeholder="english, interview, daily"
            className="h-10 sm:h-8 w-full border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 text-xs text-[var(--ds-fg)]"
          />
        </Field>

        <div className="min-w-0">
          <span className="mb-1 block text-[11px] font-medium text-[var(--ds-fg-secondary)]">
            Remote Location
          </span>
          <div className="truncate rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 py-2 sm:py-1.5 font-mono text-[11px] text-[var(--ds-fg-muted)]">
            {call.remote_uri ?? "Not uploaded"}
          </div>
        </div>
      </div>

      <Field>
        <FieldLabel className="text-[11px] font-medium text-[var(--ds-fg-secondary)]">
          Recording notes <span className="sr-only">for {displayTitle}</span>
        </FieldLabel>
        <Textarea
          rows={2}
          value={notesDraft}
          onValueChange={setNotesDraft}
          placeholder="Add observations, topics discussed, follow-ups…"
          className="min-h-16 w-full border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 py-2 sm:py-1.5 text-xs text-[var(--ds-fg)]"
        />
      </Field>

      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-[var(--ds-fg-muted)]">
          ID: {call.call_id}
        </span>
        <Button
          type="submit"
          data-variant="solid"
          disabled={saving}
          className="inline-flex h-9 sm:h-7 shrink-0 items-center gap-1.5 rounded-md border-0 bg-[var(--ds-btn-primary-bg)] px-3.5 sm:px-3 text-xs font-medium text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)]"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          <span>
            Save Details <span className="sr-only">for {displayTitle}</span>
          </span>
        </Button>
      </div>
    </form>
  );
};
