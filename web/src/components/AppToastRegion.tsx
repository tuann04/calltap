import React from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { Toast, ToastClose, ToastRegion, ToastTitle, toast } from "@ui-sdk/react/toast";

export type NotifyFn = (msg: string, tone?: "ok" | "err") => void;

export const notify: NotifyFn = (msg, tone = "ok") => {
  if (tone === "err") {
    toast.error(msg);
  } else {
    toast.success(msg);
  }
};

interface AppToastRegionProps {
  offsetForSelectionBar: boolean;
}

export const AppToastRegion: React.FC<AppToastRegionProps> = ({ offsetForSelectionBar }) => (
  <ToastRegion
    data-agent-hidden=""
    side="bottom"
    align="end"
    className={offsetForSelectionBar ? "toast-region-offset" : undefined}
  >
    {(data) => (
      <Toast
        className={`flex items-center gap-2.5 px-3.5 py-2.5 text-xs font-medium shadow-lg ${
          data.type === "error"
            ? "border-red-500/40 bg-red-950/95 text-red-100"
            : "border-[var(--ds-border-strong)] bg-[var(--ds-card)] text-[var(--ds-fg)]"
        }`}
      >
        {data.type === "error" ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
        )}
        <ToastTitle className="flex-1 font-medium text-inherit" />
        <ToastClose
          aria-label="Dismiss notification"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border-0 bg-transparent text-current opacity-75 hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </ToastClose>
      </Toast>
    )}
  </ToastRegion>
);
