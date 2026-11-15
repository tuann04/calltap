import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckSquare,
  Cloud,
  CloudOff,
  HardDrive,
  Loader2,
  Mic,
  Moon,
  Radio,
  RefreshCw,
  Search,
  Square,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "./api";
import { CallCard } from "./components/CallCard";
import { DeleteModal } from "./components/DeleteModal";
import { StorageModal } from "./components/StorageModal";
import type { CallMetadata, StatusResponse, StoragePublicView } from "./types";

function formatElapsed(startedAtIso: string): string {
  const start = new Date(startedAtIso).getTime();
  if (Number.isNaN(start)) return "00:00";
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const App: React.FC = () => {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("calltap-theme");
    return saved === "light" ? "light" : "dark";
  });

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [calls, setCalls] = useState<CallMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [serviceChoice, setServiceChoice] = useState("sesame");
  const [newTitle, setNewTitle] = useState("");
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [serviceFilter, setServiceFilter] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [storageModalOpen, setStorageModalOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<CallMetadata[]>([]);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [elapsedText, setElapsedText] = useState("00:00");

  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);

  const notify = useCallback((msg: string, tone: "ok" | "err" = "ok") => {
    setToast({ msg, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("calltap-theme", theme);
  }, [theme]);

  const fetchAll = useCallback(async (quiet = true) => {
    if (!quiet) setRefreshing(true);
    try {
      const [st, list] = await Promise.all([api.getStatus(), api.listCalls()]);
      setStatus(st);
      setCalls(list);
      setSelectedIds((prev) => {
        const valid = new Set(list.map((c) => c.call_id));
        const next = new Set<string>();
        prev.forEach((id) => {
          if (valid.has(id)) next.add(id);
        });
        return next;
      });
    } catch (err) {
      if (!quiet) {
        notify(err instanceof Error ? err.message : "Failed to refresh", "err");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [notify]);

  useEffect(() => {
    fetchAll(true);
  }, [fetchAll]);

  const hasLiveWork = Boolean(
    status?.active_call ||
      calls.some(
        (c) =>
          c.status === "recording" ||
          c.status === "finalizing" ||
          c.upload_status === "uploading" ||
          c.upload_status === "pending"
      )
  );

  useEffect(() => {
    const interval = setInterval(() => {
      fetchAll(true);
    }, hasLiveWork ? 2500 : 8000);
    return () => clearInterval(interval);
  }, [fetchAll, hasLiveWork]);

  useEffect(() => {
    const active = status?.active_call;
    if (!active) return;
    setElapsedText(formatElapsed(active.started_at));
    const timer = setInterval(() => {
      setElapsedText(formatElapsed(active.started_at));
    }, 1000);
    return () => clearInterval(timer);
  }, [status?.active_call]);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setStarting(true);
    try {
      await api.startCall({
        service: serviceChoice,
        title: newTitle.trim(),
      });
      setNewTitle("");
      await fetchAll(true);
      notify("Recording started");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Failed to start recording", "err");
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await api.stopCall();
      await fetchAll(true);
      notify("Recording stopped and saved");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Failed to stop recording", "err");
    } finally {
      setStopping(false);
    }
  };

  const handleToggleAutoDetect = async () => {
    if (!status) return;
    const next = !status.auto_detect;
    try {
      const res = await api.setAutoDetect(next);
      setStatus({ ...status, auto_detect: res.auto_detect });
      notify(res.auto_detect ? "Auto-detect enabled" : "Auto-detect paused");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Failed to update auto-detect", "err");
    }
  };

  const serviceOptions = useMemo(() => {
    const set = new Set<string>(["sesame", "chatgpt", "gemini"]);
    calls.forEach((c) => {
      if (c.service) set.add(c.service);
    });
    return ["all", ...Array.from(set)];
  }, [calls]);

  const filteredCalls = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return calls.filter((c) => {
      if (serviceFilter !== "all" && c.service !== serviceFilter) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.service.toLowerCase().includes(q) ||
        c.call_id.toLowerCase().includes(q) ||
        c.notes.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [calls, searchQuery, serviceFilter]);

  const selectableFiltered = useMemo(
    () => filteredCalls.filter((c) => c.status !== "recording"),
    [filteredCalls]
  );

  const allFilteredSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((c) => selectedIds.has(c.call_id));

  const toggleSelect = (callId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        selectableFiltered.forEach((c) => next.delete(c.call_id));
      } else {
        selectableFiltered.forEach((c) => next.add(c.call_id));
      }
      return next;
    });
  };

  const selectedCalls = useMemo(
    () => calls.filter((c) => selectedIds.has(c.call_id)),
    [calls, selectedIds]
  );

  const cloudConnected = Boolean(status?.storage.connected);

  const handleBulkUpload = async (ids?: string[]) => {
    if (!cloudConnected) {
      setStorageModalOpen(true);
      notify("Connect cloud storage first to upload", "err");
      return;
    }
    const targetIds = ids ?? Array.from(selectedIds);
    if (targetIds.length === 0) return;
    setBulkUploading(true);
    try {
      const res = await api.bulkUpload(targetIds);
      await fetchAll(true);
      if (!ids) setSelectedIds(new Set());
      notify(`Queued ${res.queued} recording${res.queued === 1 ? "" : "s"} for upload`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Bulk upload failed", "err");
    } finally {
      setBulkUploading(false);
    }
  };

  const handleUploadAllPending = async () => {
    const pendingIds = calls
      .filter(
        (c) =>
          c.status === "completed" &&
          !c.local_pruned &&
          c.upload_status !== "uploaded" &&
          c.upload_status !== "uploading"
      )
      .map((c) => c.call_id);
    if (pendingIds.length === 0) {
      notify("All completed recordings are already synced");
      return;
    }
    await handleBulkUpload(pendingIds);
  };

  const handleConfirmDelete = async (deleteRemote: boolean) => {
    const ids = deleteTargets.map((c) => c.call_id);
    if (ids.length === 1) {
      await api.deleteCall(ids[0], deleteRemote);
    } else {
      await api.bulkDelete(ids, deleteRemote);
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    await fetchAll(true);
    notify(`Deleted ${ids.length} recording${ids.length === 1 ? "" : "s"}`);
  };

  const storageView: StoragePublicView = status?.storage ?? {
    connected: false,
    source: "none",
    provider: "none",
    auto_upload: true,
    bucket: "",
    prefix: "calls",
    endpoint: "",
    region: "",
    access_key_id: "",
    has_secret: false,
    secret_hint: "",
    has_gdrive_token: false,
    gdrive_client_id: "",
    gdrive_root_folder_id: "",
    remote_label: "Local storage only",
  };

  return (
    <div className="min-h-screen bg-[var(--ds-bg)] text-[var(--ds-fg)]">
      {/* Sticky Geist Navbar */}
      <header className="sticky top-0 z-30 border-b border-[var(--ds-border)] bg-[var(--ds-bg)]/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            {/* Vercel-inspired triangle + pulse mark */}
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--ds-btn-primary-bg)] text-[var(--ds-btn-primary-fg)]">
              <Radio className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight">CallTap</span>
              <span className="hidden sm:inline-block rounded-full border border-[var(--ds-border)] px-2 py-0.5 font-mono text-[10px] text-[var(--ds-fg-muted)]">
                dual-track
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* PulseAudio + Browser Tab pill */}
            <div className="hidden md:flex items-center gap-2 rounded-full border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 py-1 text-xs">
              <span
                className={`h-2 w-2 rounded-full ${
                  status?.pulse_healthy ? "bg-emerald-500" : "bg-red-500"
                }`}
              />
              <span className="text-[var(--ds-fg-secondary)]">
                {status?.pulse_healthy ? "Audio ready" : "Pulse offline"}
              </span>
              {status?.active_tab?.service && status.active_tab.service !== "unknown" && (
                <>
                  <span className="text-[var(--ds-border-strong)]">/</span>
                  <span className="font-mono text-[11px] text-[var(--ds-fg)]">
                    {status.active_tab.service}
                  </span>
                </>
              )}
            </div>

            {/* Cloud Storage Connection Pill */}
            <button
              type="button"
              onClick={() => setStorageModalOpen(true)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition cursor-pointer ${
                cloudConnected
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/15"
                  : "border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
              }`}
              title="Configure cloud storage destination"
            >
              {cloudConnected ? (
                <Cloud className="h-3.5 w-3.5" />
              ) : (
                <HardDrive className="h-3.5 w-3.5" />
              )}
              <span className="max-w-[160px] truncate">
                {cloudConnected ? storageView.remote_label : "Local Only"}
              </span>
            </button>

            <button
              type="button"
              onClick={() => fetchAll(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </button>

            <button
              type="button"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] cursor-pointer"
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        {/* Recorder Hero Card */}
        <section className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-card)] shadow-xs">
          <div className="p-5">
            {status?.active_call ? (
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-0.5 text-[11px] font-medium text-red-500">
                      <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                      LIVE RECORDING
                    </span>
                    <span className="rounded bg-[var(--ds-muted)] px-2 py-0.5 font-mono text-xs text-[var(--ds-fg-secondary)]">
                      {status.active_call.service}
                    </span>
                  </div>
                  <h1 className="text-base font-semibold text-[var(--ds-fg)]">
                    {status.active_call.title || `${status.active_call.service} session`}
                  </h1>
                  <p className="font-mono text-xs text-[var(--ds-fg-muted)]">
                    {status.active_call.call_id} · Capturing microphone + browser audio
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] px-4 py-2 font-mono text-lg font-semibold tabular-nums text-[var(--ds-fg)]">
                    {elapsedText}
                  </div>
                  <button
                    type="button"
                    disabled={stopping}
                    onClick={handleStop}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-red-600 px-4 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50 cursor-pointer"
                  >
                    {stopping ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Square className="h-3.5 w-3.5 fill-current" />
                    )}
                    <span>Stop &amp; Save</span>
                  </button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={handleStart}
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
              >
                <div className="w-full sm:w-44">
                  <label className="mb-1.5 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Service
                  </label>
                  <select
                    value={serviceChoice}
                    onChange={(e) => setServiceChoice(e.target.value)}
                    className="h-9 w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-xs font-medium text-[var(--ds-fg)] focus:border-[var(--ds-fg)] focus:outline-none"
                  >
                    <option value="sesame">Sesame</option>
                    <option value="chatgpt">ChatGPT Voice</option>
                    <option value="gemini">Gemini Live</option>
                    <option value="custom">Custom Call</option>
                  </select>
                </div>

                <div className="flex-1">
                  <label className="mb-1.5 block text-xs font-medium text-[var(--ds-fg-secondary)]">
                    Recording Title <span className="text-[var(--ds-fg-muted)]">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g., Evening English practice with Maya"
                    className="h-9 w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={starting}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md bg-[var(--ds-btn-primary-bg)] px-4 text-xs font-semibold text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)] disabled:opacity-50 cursor-pointer"
                >
                  {starting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Mic className="h-3.5 w-3.5" />
                  )}
                  <span>Start Recording</span>
                </button>
              </form>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ds-border)] bg-[var(--ds-surface)] px-5 py-2.5 text-xs text-[var(--ds-fg-muted)] rounded-b-xl">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={Boolean(status?.auto_detect)}
                onChange={handleToggleAutoDetect}
                className="h-3.5 w-3.5 accent-[var(--ds-fg)] cursor-pointer"
              />
              <span className="text-[var(--ds-fg-secondary)]">
                Auto-detect calls from browser microphone
              </span>
            </label>

            <button
              type="button"
              onClick={() => setStorageModalOpen(true)}
              className="inline-flex items-center gap-1.5 text-xs text-[var(--ds-fg-secondary)] hover:text-[var(--ds-fg)] cursor-pointer"
            >
              {cloudConnected ? (
                <>
                  <Cloud className="h-3.5 w-3.5 text-emerald-500" />
                  <span>
                    {storageView.auto_upload
                      ? `Auto-uploading to ${storageView.remote_label}`
                      : `Connected (${storageView.remote_label}) — manual upload`}
                  </span>
                </>
              ) : (
                <>
                  <CloudOff className="h-3.5 w-3.5" />
                  <span>Saving locally · Connect R2 / S3 / Google Drive</span>
                </>
              )}
            </button>
          </div>
        </section>

        {/* Library Toolbar */}
        <section className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-fg-muted)]" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search recordings by title, service, notes, or #tag…"
                className="h-9 w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] pl-9 pr-3 text-xs text-[var(--ds-fg)] placeholder:text-[var(--ds-fg-muted)] focus:border-[var(--ds-fg)] focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={toggleSelectAll}
                disabled={selectableFiltered.length === 0}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--ds-border)] bg-[var(--ds-card)] px-2.5 text-xs text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)] disabled:opacity-40 cursor-pointer"
              >
                <CheckSquare className="h-3.5 w-3.5" />
                <span>{allFilteredSelected ? "Deselect All" : "Select All"}</span>
              </button>

              {cloudConnected && (status?.pending_uploads ?? 0) > 0 && (
                <button
                  type="button"
                  disabled={bulkUploading}
                  onClick={handleUploadAllPending}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-500 hover:bg-emerald-500/15 disabled:opacity-50 cursor-pointer"
                >
                  {bulkUploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  <span>Upload Pending ({status?.pending_uploads})</span>
                </button>
              )}
            </div>
          </div>

          {/* Service filter pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            {serviceOptions.map((svc) => {
              const active = serviceFilter === svc;
              return (
                <button
                  key={svc}
                  type="button"
                  onClick={() => setServiceFilter(svc)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition cursor-pointer ${
                    active
                      ? "border-[var(--ds-fg)] bg-[var(--ds-btn-primary-bg)] text-[var(--ds-btn-primary-fg)]"
                      : "border-[var(--ds-border)] bg-[var(--ds-card)] text-[var(--ds-fg-secondary)] hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-fg)]"
                  }`}
                >
                  {svc === "all" ? `All (${calls.length})` : svc}
                </button>
              );
            })}
          </div>
        </section>

        {/* Sticky Bulk Selection Bar */}
        {selectedCalls.length > 0 && (
          <div className="sticky top-16 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--ds-fg)]/40 bg-[var(--ds-card)]/95 px-4 py-2.5 shadow-lg backdrop-blur-md">
            <span className="text-xs font-medium text-[var(--ds-fg)]">
              {selectedCalls.length} recording{selectedCalls.length === 1 ? "" : "s"} selected
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={bulkUploading}
                onClick={() => handleBulkUpload()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--ds-btn-primary-bg)] px-3 text-xs font-medium text-[var(--ds-btn-primary-fg)] hover:bg-[var(--ds-btn-primary-hover)] disabled:opacity-50 cursor-pointer"
              >
                {bulkUploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                <span>Upload Selected</span>
              </button>

              <button
                type="button"
                onClick={() => setDeleteTargets(selectedCalls)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 text-xs font-medium text-red-400 hover:bg-red-500/20 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete Selected</span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="inline-flex h-8 items-center rounded-md border border-[var(--ds-border)] px-2.5 text-xs text-[var(--ds-fg-secondary)] hover:text-[var(--ds-fg)] cursor-pointer"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Calls List */}
        <section className="space-y-3 pb-12">
          {loading ? (
            <div className="flex items-center justify-center rounded-xl border border-[var(--ds-border)] bg-[var(--ds-card)] py-16 text-xs text-[var(--ds-fg-muted)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading recordings…
            </div>
          ) : filteredCalls.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--ds-border)] bg-[var(--ds-card)] px-6 py-14 text-center">
              <p className="text-sm font-medium text-[var(--ds-fg)]">
                {calls.length === 0 ? "No calls recorded yet" : "No matching recordings"}
              </p>
              <p className="mt-1 text-xs text-[var(--ds-fg-muted)]">
                {calls.length === 0
                  ? "Click Start Recording above, or join a voice call in your Neko browser with Auto-detect enabled."
                  : "Try clearing your search or switching the service filter."}
              </p>
            </div>
          ) : (
            filteredCalls.map((call) => (
              <CallCard
                key={call.call_id}
                call={call}
                selected={selectedIds.has(call.call_id)}
                cloudConnected={cloudConnected}
                onToggleSelect={toggleSelect}
                onUpdated={(updated) => {
                  setCalls((prev) =>
                    prev.map((item) => (item.call_id === updated.call_id ? updated : item))
                  );
                }}
                onRequestDelete={(target) => setDeleteTargets([target])}
                onNotify={notify}
              />
            ))
          )}
        </section>
      </main>

      {/* Modals */}
      <StorageModal
        open={storageModalOpen}
        storage={storageView}
        onClose={() => setStorageModalOpen(false)}
        onSaved={(next, message) => {
          setStatus((prev) => (prev ? { ...prev, storage: next } : prev));
          notify(message);
          fetchAll(true);
        }}
      />

      <DeleteModal
        targets={deleteTargets}
        cloudConnected={cloudConnected}
        onClose={() => setDeleteTargets([])}
        onConfirm={handleConfirmDelete}
      />

      {/* Toast */}
      {toast && (
        <div
          className={`fixed right-4 bottom-4 z-50 rounded-lg border px-4 py-2.5 text-xs font-medium shadow-xl ${
            toast.tone === "err"
              ? "border-red-500/40 bg-red-950/90 text-red-200"
              : "border-[var(--ds-border-strong)] bg-[var(--ds-card)] text-[var(--ds-fg)]"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
};

export default App;
