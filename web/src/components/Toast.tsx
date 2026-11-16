import React from "react";
import type { ToastState } from "../hooks/useToast";

interface ToastProps {
  toast: ToastState | null;
  offsetForSelectionBar: boolean;
}

export const Toast: React.FC<ToastProps> = ({ toast, offsetForSelectionBar }) => {
  if (!toast) return null;
  return (
    <div
      className={`fixed inset-x-4 z-50 rounded-lg border px-4 py-2.5 text-center text-xs font-medium shadow-xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:text-left ${
        offsetForSelectionBar
          ? "bottom-[calc(max(12px,env(safe-area-inset-bottom))+64px)] sm:bottom-4"
          : "bottom-[max(16px,env(safe-area-inset-bottom))]"
      } ${
        toast.tone === "err"
          ? "border-red-500/40 bg-red-950/90 text-red-200"
          : "border-[var(--ds-border-strong)] bg-[var(--ds-card)] text-[var(--ds-fg)]"
      }`}
    >
      {toast.msg}
    </div>
  );
};
