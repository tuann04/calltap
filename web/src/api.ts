import type {
  CallMetadata,
  EditCallPayload,
  StatusResponse,
  StorageConfigPayload,
  StoragePublicView,
  WaveformResponse,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data?.detail) msg = data.detail;
    } catch {
      const text = await res.text();
      if (text) msg = text;
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  getStatus: () => request<StatusResponse>("/api/status"),
  listCalls: (params?: { q?: string; service?: string }) => {
    const qs = new URLSearchParams({ limit: "100" });
    if (params?.q) qs.set("q", params.q);
    if (params?.service) qs.set("service", params.service);
    return request<CallMetadata[]>(`/api/calls?${qs.toString()}`);
  },
  setAutoDetect: (enabled: boolean) =>
    request<{ auto_detect: boolean }>("/api/auto-detect", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  startCall: (payload: { service?: string | null; title?: string; tags?: string[] }) =>
    request<CallMetadata>("/api/calls/start", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  stopCall: () =>
    request<{ stopped: boolean; call: CallMetadata | null }>("/api/calls/stop", {
      method: "POST",
    }),
  patchCall: (
    callId: string,
    payload: { title?: string; service?: string; tags?: string[]; notes?: string }
  ) =>
    request<CallMetadata>(`/api/calls/${encodeURIComponent(callId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  editCall: (callId: string, payload: EditCallPayload) =>
    request<CallMetadata>(`/api/calls/${encodeURIComponent(callId)}/edit`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteCall: (callId: string, deleteRemote = false) =>
    request<{ deleted: boolean; call_id: string }>(
      `/api/calls/${encodeURIComponent(callId)}?delete_remote=${deleteRemote ? "true" : "false"}`,
      { method: "DELETE" }
    ),
  bulkDelete: (callIds: string[], deleteRemote = false) =>
    request<{ deleted: number; call_ids: string[] }>("/api/calls/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ call_ids: callIds, delete_remote: deleteRemote }),
    }),
  bulkUpload: (callIds: string[]) =>
    request<{ queued: number; calls: CallMetadata[] }>("/api/calls/bulk-upload", {
      method: "POST",
      body: JSON.stringify({ call_ids: callIds }),
    }),
  uploadCall: (callId: string) =>
    request<CallMetadata>(`/api/calls/${encodeURIComponent(callId)}/upload`, {
      method: "POST",
    }),
  getWaveform: (callId: string) =>
    request<WaveformResponse>(`/api/calls/${encodeURIComponent(callId)}/waveform`),
  getStorage: () => request<StoragePublicView>("/api/storage"),
  saveStorage: (payload: StorageConfigPayload) =>
    request<StoragePublicView>("/api/storage", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  testStorage: (payload?: StorageConfigPayload) =>
    request<{ ok: boolean; message: string }>("/api/storage/test", {
      method: "POST",
      body: payload ? JSON.stringify(payload) : undefined,
    }),
  disconnectStorage: () =>
    request<StoragePublicView>("/api/storage", {
      method: "DELETE",
    }),
};
