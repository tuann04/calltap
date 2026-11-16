export type CallStatus = "recording" | "finalizing" | "completed" | "error";
export type UploadStatus = "pending" | "uploading" | "uploaded" | "failed" | "disabled";
export type StorageProvider = "none" | "r2" | "s3" | "b2" | "custom_s3" | "gdrive";

export interface CallFiles {
  you: string;
  agent: string;
  mix: string | null;
}

export interface CallMetadata {
  call_id: string;
  title: string;
  service: string;
  trigger: string;
  page_url: string | null;
  page_title: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  sample_rate: number;
  files: CallFiles;
  tags: string[];
  notes: string;
  local_rel_dir: string;
  status: CallStatus;
  upload_status: UploadStatus;
  upload_attempts: number;
  upload_error: string | null;
  remote_uri: string | null;
  uploaded_at: string | null;
  edited_at?: string | null;
  local_pruned: boolean;
}

export type AudioEditMode = "keep" | "cut";

export interface EditCallPayload {
  mode: AudioEditMode;
  start_seconds: number;
  end_seconds: number;
}

export interface StoragePublicView {
  connected: boolean;
  source: "ui" | "env" | "none";
  provider: StorageProvider;
  auto_upload: boolean;
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
  access_key_id: string;
  has_secret: boolean;
  secret_hint: string;
  has_gdrive_token: boolean;
  gdrive_client_id: string;
  gdrive_root_folder_id: string;
  remote_label: string;
}

export interface StorageConfigPayload {
  provider: StorageProvider;
  auto_upload: boolean;
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  gdrive_token_json: string;
  gdrive_client_id: string;
  gdrive_client_secret: string;
  gdrive_root_folder_id: string;
}

export interface StatusResponse {
  active_call: CallMetadata | null;
  auto_detect: boolean;
  pulse_healthy: boolean;
  rclone_remote: string | null;
  storage: StoragePublicView;
  pending_uploads: number;
  active_tab: {
    service: string;
    url: string | null;
    title: string | null;
  };
  vm_sleeping?: boolean;
  wake_url?: string | null;
  neko_url?: string | null;
}

export interface WaveformResponse {
  call_id: string;
  bins: number;
  duration_seconds: number;
  tracks: {
    you?: number[];
    agent?: number[];
    mix?: number[];
  };
}

export const EMPTY_STORAGE_VIEW: StoragePublicView = {
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
