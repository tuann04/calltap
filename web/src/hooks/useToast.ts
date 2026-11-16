import { useCallback, useEffect, useState } from "react";

export interface ToastState {
  msg: string;
  tone: "ok" | "err";
}

export function useToast(durationMs = 3500) {
  const [toast, setToast] = useState<ToastState | null>(null);

  const notify = useCallback((msg: string, tone: "ok" | "err" = "ok") => {
    setToast({ msg, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), durationMs);
    return () => clearTimeout(t);
  }, [toast, durationMs]);

  return { toast, notify };
}
