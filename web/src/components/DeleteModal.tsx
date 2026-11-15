import React, { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDeleteRemote(false);
    setBusy(false);
    setError(null);
  }, [targets]);

  if (targets.length === 0) return null;

  const hasRemoteCopies = targets.some((c) => Boolean(c.remote_uri));
  const isSingle = targets.length === 1;
  const label = isSingle
    ? formatCallTitle(targets[0])
    : `${targets.length} selected recordings`;

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(deleteRemote);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--ds-border)] bg-[var(--ds-card)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--ds-border)] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-red-500/30 bg-red-500/10 text-red-500">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <h2 className="text-sm font-semibold text-[var(--ds-fg)]">
              Delete {isSingle ? "Recording" : `${targets.length} Recordings`}
            </h2>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--ds-fg-muted)] hover:bg-[var(--ds-muted)] hover:text-[var(--ds-fg)] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5 text-xs text-[var(--ds-fg-secondary)]">
          <p>
            This permanently deletes <span className="font-medium text-[var(--ds-fg)]">{label}</span>{" "}
            and all local FLAC/Opus/waveform files from this machine.
          </p>

          {hasRemoteCopies && cloudConnected && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] p-3">
              <input
                type="checkbox"
                checked={deleteRemote}
                onChange={(e) => setDeleteRemote(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-red-500 cursor-pointer"
              />
              <div>
                <span className="block font-medium text-[var(--ds-fg)]">
                  Also delete from cloud storage
                </span>
                <span className="block text-[11px] text-[var(--ds-fg-muted)]">
                  Runs remote purge on uploaded folders in your connected bucket/Drive.
                </span>
              </div>
            </label>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-xs font-medium text-[var(--ds-fg)] hover:border-[var(--ds-border-strong)] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleConfirm}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 cursor-pointer"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              <span>Delete</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
