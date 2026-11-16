import React, { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "./api";
import { AppToastRegion, notify } from "./components/AppToastRegion";
import { CallCard } from "./components/CallCard";
import { DeleteModal } from "./components/DeleteModal";
import { LibraryToolbar } from "./components/LibraryToolbar";
import { Navbar } from "./components/Navbar";
import { RecorderHero } from "./components/RecorderHero";
import { StorageModal } from "./components/StorageModal";
import { useCallTapData } from "./hooks/useCallTapData";
import { useTheme } from "./hooks/useTheme";
import type { CallMetadata } from "./types";
import { formatCallTitle, formatElapsed } from "./utils/callDisplay";

export const App: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const {
    status,
    calls,
    loading,
    refreshing,
    storageView,
    cloudConnected,
    vmSleeping,
    activeTabLabel,
    fetchAll,
    updateCallItem,
    updateStorageView,
    setAutoDetectLocal,
  } = useCallTapData(notify);

  const [serviceChoice, setServiceChoice] = useState("auto");
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

  useEffect(() => {
    const valid = new Set(calls.map((c) => c.call_id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (valid.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [calls]);

  useEffect(() => {
    const active = status?.active_call;
    if (!active) return;
    setElapsedText(formatElapsed(active.started_at));
    const timer = setInterval(() => setElapsedText(formatElapsed(active.started_at)), 1000);
    return () => clearInterval(timer);
  }, [status?.active_call]);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setStarting(true);
    try {
      await api.startCall({
        service: serviceChoice === "auto" ? null : serviceChoice,
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
    try {
      const res = await api.setAutoDetect(!status.auto_detect);
      setAutoDetectLocal(res.auto_detect);
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
        formatCallTitle(c).toLowerCase().includes(q) ||
        c.service.toLowerCase().includes(q) ||
        c.call_id.toLowerCase().includes(q) ||
        c.notes.toLowerCase().includes(q) ||
        (c.page_url ?? "").toLowerCase().includes(q) ||
        (c.page_title ?? "").toLowerCase().includes(q) ||
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

  return (
    <div className="min-h-dvh bg-[var(--ds-bg)] text-[var(--ds-fg)]">
      <Navbar
        theme={theme}
        onToggleTheme={toggleTheme}
        vmSleeping={vmSleeping}
        pulseHealthy={Boolean(status?.pulse_healthy)}
        activeTabLabel={activeTabLabel}
        storageView={storageView}
        cloudConnected={cloudConnected}
        refreshing={refreshing}
        onRefresh={() => fetchAll(false)}
        onOpenStorage={() => setStorageModalOpen(true)}
      />

      <main className="mx-auto max-w-5xl space-y-5 sm:space-y-6 px-3 py-4 sm:px-6 sm:py-6">
        <RecorderHero
          status={status}
          storageView={storageView}
          cloudConnected={cloudConnected}
          vmSleeping={vmSleeping}
          wakeUrl={status?.wake_url || "/?wake=1"}
          nekoUrl={status?.neko_url || null}
          activeTabLabel={activeTabLabel}
          elapsedText={elapsedText}
          serviceChoice={serviceChoice}
          onServiceChoiceChange={setServiceChoice}
          newTitle={newTitle}
          onNewTitleChange={setNewTitle}
          starting={starting}
          stopping={stopping}
          onStart={handleStart}
          onStop={handleStop}
          onToggleAutoDetect={handleToggleAutoDetect}
          onOpenStorage={() => setStorageModalOpen(true)}
        />

        <LibraryToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          serviceOptions={serviceOptions}
          serviceFilter={serviceFilter}
          onServiceFilterChange={setServiceFilter}
          totalCallsCount={calls.length}
          selectableCount={selectableFiltered.length}
          allFilteredSelected={allFilteredSelected}
          onToggleSelectAll={toggleSelectAll}
          cloudConnected={cloudConnected}
          pendingUploads={status?.pending_uploads ?? 0}
          bulkUploading={bulkUploading}
          onUploadAllPending={handleUploadAllPending}
          selectedCalls={selectedCalls}
          onBulkUploadSelected={() => handleBulkUpload()}
          onBulkDeleteSelected={() => setDeleteTargets(selectedCalls)}
          onClearSelection={() => setSelectedIds(new Set())}
        />

        <section
          className={`space-y-3 ${
            selectedCalls.length > 0
              ? "pb-24 sm:pb-12"
              : "pb-[max(3rem,env(safe-area-inset-bottom))]"
          }`}
        >
          {loading ? (
            <div className="flex items-center justify-center rounded-xl border border-[var(--ds-border)] bg-[var(--ds-card)] py-16 text-xs text-[var(--ds-fg-muted)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
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
                onUpdated={updateCallItem}
                onRequestDelete={(target) => setDeleteTargets([target])}
                onNotify={notify}
              />
            ))
          )}
        </section>
      </main>

      <StorageModal
        open={storageModalOpen}
        storage={storageView}
        onClose={() => setStorageModalOpen(false)}
        onSaved={(next, message) => {
          updateStorageView(next);
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

      <AppToastRegion offsetForSelectionBar={selectedCalls.length > 0} />
    </div>
  );
};

export default App;
