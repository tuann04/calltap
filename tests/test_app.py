from pathlib import Path
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from calltap.app import create_app
from calltap.config import Settings
from calltap.recorder import RecordingResult


def test_app_dashboard_and_call_lifecycle(tmp_path: Path) -> None:
    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        auto_detect=False,
        dashboard_user="tuan",
        dashboard_pass="secret",
    )
    app = create_app(cfg, start_background=False)

    # Stub recorder and pulse so API test runs without PulseAudio daemon.
    ctrl = app.state.controller
    ctrl.pulse.is_healthy = AsyncMock(return_value=True)
    ctrl.inspector.active_tab = AsyncMock(
        return_value=ctrl.inspector.active_tab.return_value
        if hasattr(ctrl.inspector.active_tab, "return_value")
        else None
    )
    from calltap.cdp import TabContext

    ctrl.inspector.active_tab = AsyncMock(
        return_value=TabContext(service="sesame", url="https://app.sesame.com", title="Sesame")
    )

    recording_dir_holder: dict[str, Path] = {}

    async def fake_start(call_dir: Path, **_kwargs) -> None:
        recording_dir_holder["dir"] = call_dir
        (call_dir / "you.flac").write_bytes(b"fLaC-you")
        (call_dir / "agent.flac").write_bytes(b"fLaC-agent")
        (call_dir / "mix.opus").write_bytes(b"OggS-mix")
        ctrl.recorder._proc = object()  # mark active

    async def fake_stop() -> RecordingResult:
        d = recording_dir_holder["dir"]
        ctrl.recorder._proc = None
        return RecordingResult(
            you_path=d / "you.flac",
            agent_path=d / "agent.flac",
            mix_path=d / "mix.opus",
            exit_code=0,
            stderr_tail="",
        )

    ctrl.recorder.start = fake_start  # type: ignore[method-assign]
    ctrl.recorder.stop = fake_stop  # type: ignore[method-assign]
    type(ctrl.recorder).is_recording = property(lambda self: self._proc is not None)  # type: ignore[misc]

    with TestClient(app) as client:
        # Unauthenticated request fails when dashboard_user is configured
        assert client.get("/").status_code == 401
        assert client.get("/healthz").status_code == 200

        auth = ("tuan", "secret")
        assert client.get("/", auth=auth).status_code == 200

        r_start = client.post("/api/calls/start", json={"tags": ["practice"]}, auth=auth)
        assert r_start.status_code == 200
        call_id = r_start.json()["call_id"]
        assert r_start.json()["service"] == "sesame"

        r_stop = client.post("/api/calls/stop", auth=auth)
        assert r_stop.status_code == 200
        assert r_stop.json()["stopped"] is True

        r_patch = client.patch(
            f"/api/calls/{call_id}",
            json={"tags": ["sesame", "pronunciation"], "notes": "good pacing"},
            auth=auth,
        )
        assert r_patch.status_code == 200
        assert r_patch.json()["notes"] == "good pacing"

        r_audio = client.get(f"/api/calls/{call_id}/audio/you", auth=auth)
        assert r_audio.status_code == 200
        assert r_audio.content == b"fLaC-you"


def test_cf_access_jwt_auth_and_fallback(tmp_path: Path) -> None:
    import json
    from datetime import UTC, datetime, timedelta

    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    from calltap.cf_access import CloudflareAccessVerifier

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk_dict = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk_dict["kid"] = "test-kid-1"
    jwk_dict["use"] = "sig"
    jwk_dict["alg"] = "RS256"

    aud = "test-aud-123"
    team = "tuann04"
    verifier = CloudflareAccessVerifier(
        team=team,
        audience=aud,
        allowed_emails={"voanhtuan2004@gmail.com"},
        jwks_override={"keys": [jwk_dict]},
    )

    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        auto_detect=False,
        dashboard_user="calltap",
        dashboard_pass="secret",
        cf_access_team=team,
        cf_access_aud=aud,
        cf_access_allowed_emails="Voanhtuan2004@gmail.com",
    )
    app = create_app(cfg, start_background=False, cf_verifier=verifier)

    now = datetime.now(UTC)
    valid_token = jwt.encode(
        {
            "aud": [aud],
            "iss": "https://tuann04.cloudflareaccess.com",
            "email": "Voanhtuan2004@gmail.com",
            "exp": int((now + timedelta(minutes=10)).timestamp()),
            "iat": int(now.timestamp()),
        },
        private_key,
        algorithm="RS256",
        headers={"kid": "test-kid-1"},
    )
    wrong_email_token = jwt.encode(
        {
            "aud": [aud],
            "iss": "https://tuann04.cloudflareaccess.com",
            "email": "other@example.com",
            "exp": int((now + timedelta(minutes=10)).timestamp()),
            "iat": int(now.timestamp()),
        },
        private_key,
        algorithm="RS256",
        headers={"kid": "test-kid-1"},
    )

    with TestClient(app) as client:
        # Unauthenticated fails
        assert client.get("/").status_code == 401
        # Valid CF Access JWT passes without Basic Auth
        assert (
            client.get("/", headers={"Cf-Access-Jwt-Assertion": valid_token}).status_code == 200
        )
        # Wrong email is rejected
        assert (
            client.get("/", headers={"Cf-Access-Jwt-Assertion": wrong_email_token}).status_code
            == 401
        )
        # Wrong audience is rejected
        bad_aud_token = jwt.encode(
            {
                "aud": ["other-aud"],
                "iss": "https://tuann04.cloudflareaccess.com",
                "email": "Voanhtuan2004@gmail.com",
                "exp": int((now + timedelta(minutes=10)).timestamp()),
            },
            private_key,
            algorithm="RS256",
            headers={"kid": "test-kid-1"},
        )
        assert (
            client.get("/", headers={"Cf-Access-Jwt-Assertion": bad_aud_token}).status_code == 401
        )
        # Basic Auth fallback still works
        assert client.get("/", auth=("calltap", "secret")).status_code == 200


def test_metrics_and_telemetry_endpoints(tmp_path: Path) -> None:
    cfg = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "calls",
        db_path=tmp_path / "calltap.db",
        auto_detect=False,
        dashboard_user="tuan",
        dashboard_pass="secret",
        log_json=False,
    )
    app = create_app(cfg, start_background=False)
    auth = ("tuan", "secret")

    with TestClient(app) as client:
        assert client.post("/api/telemetry", json={"event": "x"}).status_code == 401
        r_tel = client.post(
            "/api/telemetry",
            json={
                "events": [
                    {
                        "event": "page_load",
                        "level": "info",
                        "source": "web",
                        "message": "loaded",
                        "data": {"path": "/"},
                    },
                    {
                        "event": "audio_error",
                        "level": "error",
                        "source": "web",
                        "message": "decode error",
                    },
                ]
            },
            auth=auth,
        )
        assert r_tel.status_code == 200
        assert r_tel.json() == {"accepted": 2}

        r_metrics = client.get("/metrics")
        assert r_metrics.status_code == 200
        body = r_metrics.text
        assert "calltap_calls_active" in body
        assert "calltap_pending_uploads" in body
        assert 'calltap_browser_events_total{event="page_load",level="info",source="web"}' in body


