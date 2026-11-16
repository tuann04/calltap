from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CALLTAP_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "0.0.0.0"
    port: int = 8090

    data_dir: Path = Path("/data")
    recordings_dir: Path = Path("/data/calls")
    db_path: Path = Path("/data/calltap.db")

    pulse_server: str = "unix:/var/run/pulse/pulseaudio.socket"
    user_source: str = "audio_input.monitor"
    agent_source: str = "audio_output.monitor"
    mic_source_names: list[str] = Field(
        default_factory=lambda: ["microphone", "audio_input.monitor"]
    )
    browser_process_hints: list[str] = Field(
        default_factory=lambda: ["chrome", "chromium", "firefox", "brave", "msedge"]
    )

    sample_rate: int = 48000
    create_stereo_mix: bool = True
    stop_grace_seconds: float = 2.5
    silence_stop_seconds: float = 20.0
    silence_threshold_db: float = -55.0
    neko_metrics_url: str = "http://neko:8080/metrics"
    neko_disconnect_stop_seconds: float = 10.0
    poll_interval_seconds: float = 0.5
    auto_detect: bool = True
    default_service: str = "unknown"

    cdp_url: str = "http://neko:9222"

    rclone_remote: str = ""
    rclone_config: Path = Path("/config/rclone/rclone.conf")
    rclone_remote_prefix: str = "calls"
    upload_poll_seconds: float = 5.0
    upload_max_retries: int = 12
    local_retention_days: int = 7

    ntfy_url: str = ""

    dashboard_user: str = ""
    dashboard_pass: str = ""

    cf_access_team: str = ""
    cf_access_aud: str = ""
    cf_access_allowed_emails: str = ""

    otlp_endpoint: str = ""
    service_name: str = "calltap"
    log_json: bool = False
    metrics_enabled: bool = True

    @property
    def cf_access_enabled(self) -> bool:
        return bool(self.cf_access_team.strip() and self.cf_access_aud.strip())

    @property
    def cf_access_email_set(self) -> set[str]:
        return {
            item.strip().lower()
            for item in self.cf_access_allowed_emails.split(",")
            if item.strip()
        }

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.recordings_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
