export type TelemetryLevel = "debug" | "info" | "warn" | "error";

interface TelemetryEventPayload {
  event: string;
  level: TelemetryLevel;
  source: string;
  message: string;
  data: Record<string, unknown>;
}

const queue: TelemetryEventPayload[] = [];
let flushTimer: number | null = null;
let initialized = false;

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushTelemetry();
  }, 1000);
}

export async function flushTelemetry(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, 50);
  try {
    await fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body: JSON.stringify({ events: batch }),
    });
  } catch {
    // Ignore telemetry transport errors so UI never breaks.
  }
}

export function trackEvent(
  event: string,
  opts?: {
    level?: TelemetryLevel;
    message?: string;
    data?: Record<string, unknown>;
  }
): void {
  queue.push({
    event: event.slice(0, 80),
    level: opts?.level ?? "info",
    source: "web",
    message: (opts?.message ?? "").slice(0, 500),
    data: opts?.data ?? {},
  });
  if (queue.length >= 10) {
    void flushTelemetry();
  } else {
    scheduleFlush();
  }
}

export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;

  window.addEventListener("error", (ev) => {
    trackEvent("window_error", {
      level: "error",
      message: ev.message || "Uncaught error",
      data: {
        filename: ev.filename,
        lineno: ev.lineno,
        colno: ev.colno,
      },
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const reason =
      ev.reason instanceof Error
        ? ev.reason.message
        : typeof ev.reason === "string"
          ? ev.reason
          : "Unhandled promise rejection";
    trackEvent("unhandled_rejection", {
      level: "error",
      message: reason,
    });
  });

  window.addEventListener("pagehide", () => {
    void flushTelemetry();
  });

  trackEvent("page_load", {
    level: "info",
    data: {
      path: window.location.pathname,
      ua: navigator.userAgent.slice(0, 120),
    },
  });
}
