import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { toast } from "@ui-sdk/react/toast";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api } from "./api";
import type { CallMetadata, StatusResponse, StoragePublicView } from "./types";

let approveConfirm = false;
const agent = createAgent({
  allow: (step) => !step.confirm || approveConfirm,
});

const LOCAL_STORAGE_VIEW: StoragePublicView = {
  provider: "none",
  connected: false,
  auto_upload: true,
  source: "ui",
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
  remote_label: "Local Only",
};

const R2_STORAGE_VIEW: StoragePublicView = {
  ...LOCAL_STORAGE_VIEW,
  provider: "r2",
  connected: true,
  bucket: "calltap-bucket",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  access_key_id: "AKIAEXAMPLE",
  has_secret: true,
  secret_hint: "••••cret",
  remote_label: "R2 (calltap-bucket/calls)",
};

const SAMPLE_CALLS: CallMetadata[] = [
  {
    call_id: "call-1",
    service: "sesame",
    title: "Maya Morning Practice",
    trigger: "manual",
    started_at: "2026-06-01T10:00:00Z",
    ended_at: "2026-06-01T10:05:00Z",
    duration_seconds: 300,
    sample_rate: 48000,
    status: "completed",
    files: { you: "you.flac", agent: "agent.flac", mix: "mix.flac" },
    local_rel_dir: "2026-06-01/call-1",
    upload_status: "uploaded",
    upload_attempts: 1,
    remote_uri: "r2://calltap-bucket/calls/call-1",
    uploaded_at: "2026-06-01T10:05:05Z",
    upload_error: null,
    page_url: "https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice",
    page_title: "Maya | Sesame",
    notes: "Initial pronunciation warm-up",
    tags: ["english", "morning"],
    local_pruned: false,
  },
  {
    call_id: "call-2",
    service: "chatgpt",
    title: "Architecture Brainstorm",
    trigger: "manual",
    started_at: "2026-06-01T12:00:00Z",
    ended_at: "2026-06-01T12:02:00Z",
    duration_seconds: 120,
    sample_rate: 48000,
    status: "completed",
    files: { you: "", agent: "", mix: "mix.flac" },
    local_rel_dir: "2026-06-01/call-2",
    upload_status: "pending",
    upload_attempts: 0,
    remote_uri: null,
    uploaded_at: null,
    upload_error: null,
    page_url: "https://chatgpt.com",
    page_title: "ChatGPT",
    notes: "",
    tags: [],
    local_pruned: false,
  },
];

function makeStatus(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    pulse_healthy: true,
    auto_detect: true,
    active_call: null,
    rclone_remote: null,
    active_tab: {
      url: "https://www.sesame.com",
      title: "Sesame",
      service: "sesame",
    },
    storage: LOCAL_STORAGE_VIEW,
    pending_uploads: 0,
    ...overrides,
  };
}

describe("CallTap UI with ui-sdk", () => {
  beforeEach(() => {
    approveConfirm = false;
    vi.restoreAllMocks();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

    vi.spyOn(api, "getStatus").mockResolvedValue(makeStatus());
    vi.spyOn(api, "listCalls").mockResolvedValue(SAMPLE_CALLS);
    vi.spyOn(api, "getWaveform").mockResolvedValue({
      call_id: "call-1",
      duration_seconds: 300,
      bins: 4,
      tracks: {
        you: [0.2, 0.8, 0.4, 0.6],
        agent: [0.5, 0.3, 0.9, 0.2],
        mix: [0.5, 0.8, 0.9, 0.6],
      },
    });
    vi.spyOn(api, "startCall").mockResolvedValue(SAMPLE_CALLS[0]);
    vi.spyOn(api, "stopCall").mockResolvedValue({ stopped: true, call: SAMPLE_CALLS[0] });
    vi.spyOn(api, "setAutoDetect").mockImplementation(async (enabled) => ({
      auto_detect: enabled,
    }));
    vi.spyOn(api, "patchCall").mockImplementation(async (callId, patch) => ({
      ...SAMPLE_CALLS.find((c) => c.call_id === callId)!,
      ...patch,
    }));
    vi.spyOn(api, "deleteCall").mockResolvedValue({ deleted: true, call_id: "call-1" });
    vi.spyOn(api, "bulkDelete").mockResolvedValue({ deleted: 0, call_ids: [] });
    vi.spyOn(api, "testStorage").mockResolvedValue({ ok: true, message: "R2 reachable" });
    vi.spyOn(api, "saveStorage").mockResolvedValue(R2_STORAGE_VIEW);
    vi.spyOn(api, "disconnectStorage").mockResolvedValue(LOCAL_STORAGE_VIEW);
  });

  afterEach(() => {
    toast.dismiss();
  });

  it("names every snapshot component cleanly and lets an agent operate recorder controls", async () => {
    render(<App />);
    await screen.findByText("Maya Morning Practice");

    const entries = agent
      .snapshot()
      .filter((entry) => !entry.offPage && entry.component !== "more");
    for (const entry of entries) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
    }

    const labels = entries.map((entry) => entry.label);
    for (const required of [
      "Service",
      "Recording Title (optional)",
      "Start Recording",
      "Auto-detect calls from browser microphone",
      "Search recordings",
      "Filter by provider",
      "Select all recordings",
      "Refresh recordings",
      "Playback position for Maya Morning Practice",
      "Audio track for Maya Morning Practice",
      "Notes for Maya Morning Practice",
      "Delete Maya Morning Practice",
    ]) {
      expect(labels, `${required} is missing from agent snapshot`).toContain(required);
    }

    const actResult = await agent.act({
      steps: [
        { ref: "Service", action: "setValue", args: ["ChatGPT Voice"] },
        { ref: "Recording Title (optional)", action: "setValue", args: ["Design sync"] },
        { ref: "Auto-detect calls from browser microphone", action: "setChecked", args: [false] },
        { ref: "Start Recording", action: "press" },
      ],
    });
    expect(actResult.ok, actResult.error?.message).toBe(true);
    expect(api.setAutoDetect).toHaveBeenCalledWith(false);
    expect(api.startCall).toHaveBeenCalledWith({
      service: "chatgpt",
      title: "Design sync",
    });
  });

  it("filters calls, searches, toggles audio tracks, and saves notes & tags", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Maya Morning Practice");
    expect(screen.getByText("Architecture Brainstorm")).toBeTruthy();

    const chatgptTab = screen.getByRole("radio", { name: "chatgpt" });
    await user.click(chatgptTab);
    expect(screen.queryByText("Maya Morning Practice")).toBeNull();
    expect(screen.getByText("Architecture Brainstorm")).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: /^All \(/ }));
    expect(screen.getByText("Maya Morning Practice")).toBeTruthy();

    const searchInput = screen.getByRole("searchbox", { name: "Search recordings" });
    await user.type(searchInput, "pronunciation");
    expect(screen.queryByText("Architecture Brainstorm")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Architecture Brainstorm")).toBeTruthy();

    const trackAct = await agent.act({
      steps: [
        { ref: "Audio track for Maya Morning Practice", action: "setValue", args: ["You"] },
      ],
    });
    expect(trackAct.ok, trackAct.error?.message).toBe(true);
    const downloadLink = screen.getByRole("link", {
      name: /Download you audio for Maya Morning Practice/,
    });
    expect(downloadLink.getAttribute("href")).toBe("/api/calls/call-1/audio/you?download=1");

    await user.click(screen.getByRole("button", { name: /Notes for Maya Morning Practice/ }));
    const tagsInput = screen.getByLabelText(/Tags \(comma separated\) for Maya Morning Practice/);
    await user.clear(tagsInput);
    await user.type(tagsInput, "english, fluency");
    const notesInput = screen.getByLabelText(/Recording notes for Maya Morning Practice/);
    await user.clear(notesInput);
    await user.type(notesInput, "Great flow today");
    await user.click(screen.getByRole("button", { name: /Save Details for Maya Morning Practice/ }));

    await waitFor(() => {
      expect(api.patchCall).toHaveBeenCalledWith("call-1", {
        tags: ["english", "fluency"],
        notes: "Great flow today",
      });
    });
  });

  it("configures cloud storage inside Dialog with password toggle and disconnect guard", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Maya Morning Practice");

    await user.click(screen.getByRole("button", { name: /Local Only storage settings/ }));
    expect(screen.getByRole("dialog", { name: "Cloud Storage" })).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "Cloudflare R2" }));
    await user.type(screen.getByLabelText("Bucket"), "calltap-bucket");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://acct.r2.cloudflarestorage.com");
    await user.type(screen.getByLabelText("Access Key ID"), "AKIAEXAMPLE");

    const secretInput = screen.getByLabelText("Secret Access Key") as HTMLInputElement;
    expect(secretInput.type).toBe("password");
    await user.type(secretInput, "super-secret");
    await user.click(screen.getByRole("button", { name: "Show secret access key" }));
    expect(secretInput.type).toBe("text");

    const autoUploadSwitch = screen.getByRole("switch", {
      name: "Auto-upload when calls finish",
    });
    autoUploadSwitch.focus();
    await user.keyboard(" ");
    expect(autoUploadSwitch.getAttribute("aria-checked")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Test Connection" }));
    expect(await screen.findByText("R2 reachable")).toBeTruthy();

    vi.spyOn(api, "getStatus").mockResolvedValue(makeStatus({ storage: R2_STORAGE_VIEW }));
    await user.click(screen.getByRole("button", { name: "Save Storage" }));
    await waitFor(() => {
      expect(api.saveStorage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "r2",
          bucket: "calltap-bucket",
          auto_upload: false,
          secret_access_key: "super-secret",
        })
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Cloud Storage" })).toBeNull();
    });

    // Reopen when R2 is connected and verify agent confirm guard on Disconnect
    await user.click(screen.getByRole("button", { name: /R2 \(calltap-bucket\/calls\) storage settings/ }));
    expect(screen.getByRole("dialog", { name: "Cloud Storage" })).toBeTruthy();

    const deniedDisconnect = await agent.act({
      steps: [{ ref: "Disconnect", action: "press" }],
    });
    expect(deniedDisconnect.ok).toBe(false);
    expect(deniedDisconnect.error?.message).toContain("Disconnects cloud storage");
    expect(api.disconnectStorage).not.toHaveBeenCalled();

    vi.spyOn(api, "getStatus").mockResolvedValue(makeStatus());
    approveConfirm = true;
    const allowedDisconnect = await agent.act({
      steps: [{ ref: "Disconnect", action: "press" }],
    });
    expect(allowedDisconnect.ok, allowedDisconnect.error?.message).toBe(true);
    await waitFor(() => {
      expect(api.disconnectStorage).toHaveBeenCalledTimes(1);
    });
  });

  it("enforces agent confirmation and error handling in Delete AlertDialog", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getStatus").mockResolvedValue(makeStatus({ storage: R2_STORAGE_VIEW }));
    render(<App />);
    await screen.findByText("Maya Morning Practice");

    const deleteTrigger = screen.getByRole("button", { name: "Delete Maya Morning Practice" });
    await user.click(deleteTrigger);
    expect(screen.getByRole("alertdialog", { name: "Delete Recording" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.deleteCall).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(deleteTrigger);

    // Agent cannot confirm deletion without explicit approval
    const denied = await agent.act({
      steps: [
        { ref: "Delete Maya Morning Practice", action: "press" },
        { ref: "Delete Recording", action: "press", args: ["Delete forever"] },
      ],
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain("Permanently deletes selected recordings");
    expect(api.deleteCall).not.toHaveBeenCalled();

    // Close and retry with approval granted, including remote checkbox via Space
    await user.keyboard("{Escape}");
    await user.click(deleteTrigger);
    const remoteCheckbox = screen.getByRole("checkbox", {
      name: "Also delete from cloud storage",
    });
    remoteCheckbox.focus();
    await user.keyboard(" ");
    expect(remoteCheckbox.getAttribute("aria-checked")).toBe("true");

    approveConfirm = true;
    const allowed = await agent.act({
      steps: [{ ref: "Delete Recording", action: "press", args: ["Delete forever"] }],
    });
    expect(allowed.ok, allowed.error?.message).toBe(true);
    await waitFor(() => {
      expect(api.deleteCall).toHaveBeenCalledWith("call-1", true);
    });
  });

  it("keeps Delete AlertDialog open with an error message when deletion fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "deleteCall").mockRejectedValueOnce(new Error("Disk busy"));
    render(<App />);
    await screen.findByText("Maya Morning Practice");

    await user.click(screen.getByRole("button", { name: "Delete Maya Morning Practice" }));
    await user.click(screen.getByRole("button", { name: "Delete forever" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete Recording" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Disk busy");
  });
});
