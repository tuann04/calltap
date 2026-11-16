import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import {
  EMPTY_STORAGE_VIEW,
  type CallMetadata,
  type StatusResponse,
  type StoragePublicView,
} from "../types";
import type { NotifyFn } from "../components/AppToastRegion";
import { extractHostname } from "../utils/callDisplay";

export function useCallTapData(notify: NotifyFn) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [calls, setCalls] = useState<CallMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = useCallback(
    async (quiet = true) => {
      if (!quiet) setRefreshing(true);
      try {
        const [st, list] = await Promise.all([api.getStatus(), api.listCalls()]);
        setStatus(st);
        setCalls(list);
      } catch (err) {
        if (!quiet) notify(err instanceof Error ? err.message : "Failed to refresh", "err");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [notify]
  );

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
    const interval = setInterval(() => fetchAll(true), hasLiveWork ? 2500 : 8000);
    return () => clearInterval(interval);
  }, [fetchAll, hasLiveWork]);

  const updateCallItem = useCallback((updated: CallMetadata) => {
    setCalls((prev) => prev.map((item) => (item.call_id === updated.call_id ? updated : item)));
  }, []);

  const updateStorageView = useCallback((next: StoragePublicView) => {
    setStatus((prev) => (prev ? { ...prev, storage: next } : prev));
  }, []);

  const setAutoDetectLocal = useCallback((enabled: boolean) => {
    setStatus((prev) => (prev ? { ...prev, auto_detect: enabled } : prev));
  }, []);

  const storageView = status?.storage ?? EMPTY_STORAGE_VIEW;
  const cloudConnected = Boolean(status?.storage.connected);
  const vmSleeping = Boolean(status?.vm_sleeping);
  const activeTabLabel =
    status?.active_tab?.service && status.active_tab.service !== "unknown"
      ? status.active_tab.service
      : extractHostname(status?.active_tab?.url ?? null);

  return {
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
  };
}
