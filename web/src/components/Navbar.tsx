import React from "react";
import { Cloud, HardDrive, Moon, Radio, RefreshCw, Sun } from "lucide-react";
import { Button } from "@ui-sdk/react/button";
import type { StoragePublicView } from "../types";

interface NavbarProps {
  theme: "dark" | "light";
  onToggleTheme: () => void;
  vmSleeping: boolean;
  pulseHealthy: boolean;
  activeTabLabel: string | null;
  storageView: StoragePublicView;
  cloudConnected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenStorage: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  theme,
  onToggleTheme,
  vmSleeping,
  pulseHealthy,
  activeTabLabel,
  storageView,
  cloudConnected,
  refreshing,
  onRefresh,
  onOpenStorage,
}) => {
  const statusDot = vmSleeping ? "bg-sky-400" : pulseHealthy ? "bg-emerald-500" : "bg-red-500";
  const statusText = vmSleeping
    ? "VM sleeping ($0/hr) · Serverless R2"
    : pulseHealthy
      ? "Audio ready"
      : "Pulse offline";

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--ds-border)] bg-[var(--ds-bg)]/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className="mx-auto flex h-13 sm:h-14 max-w-5xl items-center justify-between gap-2 px-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--ds-btn-primary-bg)] text-[var(--ds-btn-primary-fg)]">
            <Radio className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold tracking-tight">CallTap</span>
            <span className={`h-2 w-2 shrink-0 rounded-full md:hidden ${statusDot}`} title={statusText} />
            <span className="hidden sm:inline-block rounded-full border border-[var(--ds-border)] px-2 py-0.5 font-mono text-[10px] text-[var(--ds-fg-muted)]">
              dual-track
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <div className="hidden md:flex items-center gap-2 rounded-full border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1 text-xs">
            <span className={`h-2 w-2 rounded-full ${statusDot}`} />
            <span className="text-[var(--ds-fg-secondary)]">{statusText}</span>
            {activeTabLabel && (
              <>
                <span className="text-[var(--ds-border-strong)]">/</span>
                <span className="max-w-[140px] truncate font-mono text-[11px] text-[var(--ds-fg)]">
                  {activeTabLabel}
                </span>
              </>
            )}
          </div>

          <Button
            type="button"
            disabled={vmSleeping}
            onClick={onOpenStorage}
            className={`inline-flex h-9 sm:h-8 items-center gap-1.5 rounded-full border px-2.5 sm:px-3 text-xs font-medium transition ${
              cloudConnected
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/15"
                : "border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
            }`}
            title="Configure cloud storage destination"
          >
            {cloudConnected ? (
              <Cloud className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <HardDrive className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="max-w-[96px] sm:max-w-[160px] truncate">
              {cloudConnected ? (
                storageView.remote_label
              ) : (
                <>
                  Local <span className="hidden sm:inline">Only</span>
                </>
              )}{" "}
              <span className="sr-only">storage settings</span>
            </span>
          </Button>

          <Button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh recordings"
            className="inline-flex h-9 w-9 sm:h-8 sm:w-8 items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>

          <Button
            type="button"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className="inline-flex h-9 w-9 sm:h-8 sm:w-8 items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? (
              <Sun className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Moon className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </header>
  );
};
