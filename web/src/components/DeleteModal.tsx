import React, { useState } from "react";
import { AlertTriangle, Check, Loader2, Trash2, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import type { CallMetadata } from "../types";
import { formatCallTitle } from "../utils/callDisplay";

interface DeleteModalProps {
  targets: CallMetadata[];
  cloudConnected: boolean;
  onClose: () => void;
  onConfirm: (deleteRemote: boolean) => Promise<void>;
}

export const DeleteModal: React.FC<DeleteModalProps> = ({
  targets,
  cloudConnected,
  onClose,
  onConfirm,
}) => {
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = targets.length > 0;
  const hasRemoteCopies = targets.some((c) => Boolean(c.remote_uri));
  const isSingle = targets.length === 1;
  const label = isSingle
    ? formatCallTitle(targets[0])
    : `${targets.length} selected recordings`;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) {
          setDeleteRemote(false);
          setError(null);
        }
      }}
      pendingAnnouncement="Deleting recordings"
    >
      <AlertDialogBackdrop className="backdrop-blur-xs" />
      <AlertDialogContent className="w-[min(28rem,calc(100%-2rem))] gap-0 overflow-hidden rounded-t-2xl sm:rounded-xl border border-[var(--ds-border)] bg-[var(--ds-card)] p-0 shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--ds-border)] px-4 sm:px-5 py-3.5 sm:py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-red-500/30 bg-red-500/10 text-red-500">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            </div>
            <AlertDialogTitle className="text-sm font-semibold text-[var(--ds-fg)]">
              Delete {isSingle ? "Recording" : `${targets.length} Recordings`}
            </AlertDialogTitle>
          </div>

          <AlertDialogClose
            aria-label="Close delete dialog"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border-0 bg-transparent text-[var(--ds-fg-muted)] hover:bg-[var(--ds-muted)] hover:text-[var(--ds-fg)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </AlertDialogClose>
        </div>

        <div className="space-y-4 px-4 sm:px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:py-5 text-xs text-[var(--ds-fg-secondary)]">
          <AlertDialogDescription className="break-words text-xs text-[var(--ds-fg-secondary)]">
            This permanently deletes{" "}
            <span className="font-medium text-[var(--ds-fg)]">{label}</span> and all local
            FLAC/Opus/waveform files from this machine.
          </AlertDialogDescription>

          {hasRemoteCopies && cloudConnected && (
            <Field className="flex-row items-start gap-3 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] p-3">
              <Checkbox
                checked={deleteRemote}
                onCheckedChange={(checked) => setDeleteRemote(checked === true)}
                className="mt-0.5 shrink-0"
              >
                <CheckboxIndicator>
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                </CheckboxIndicator>
              </Checkbox>
              <div className="min-w-0 flex-1">
                <FieldLabel className="cursor-pointer font-medium text-[var(--ds-fg)]">
                  Also delete from cloud storage
                </FieldLabel>
                <FieldDescription className="text-[11px]">
                  Runs remote purge on uploaded folders in your connected bucket/Drive.
                </FieldDescription>
              </div>
            </Field>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400"
            >
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <AlertDialogClose className="inline-flex h-10 sm:h-8 flex-1 sm:flex-initial items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3.5 text-xs font-medium text-[var(--ds-fg)] hover:border-[var(--ds-border-strong)]">
              Cancel
            </AlertDialogClose>

            <AlertDialogClose
              value="confirm"
              data-variant="solid"
              data-agent-confirm="Permanently deletes selected recordings and local audio files"
              action={async () => {
                setError(null);
                try {
                  await onConfirm(deleteRemote);
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Delete failed");
                  throw err;
                }
              }}
              className="inline-flex h-10 sm:h-8 flex-1 sm:flex-initial items-center justify-center gap-1.5 rounded-md border-0 bg-red-600 px-4 sm:px-3.5 text-xs font-medium text-white hover:bg-red-500"
            >
              {(state) => (
                <>
                  {state.pending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>{state.pending ? "Deleting…" : "Delete forever"}</span>
                </>
              )}
            </AlertDialogClose>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};
