from __future__ import annotations

import json
import logging
from contextlib import nullcontext
from datetime import UTC, datetime
from typing import Any

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from prometheus_client import Counter, Gauge, Histogram

from calltap.config import Settings

# Prometheus metrics registered once at module import time.
CALLS_ACTIVE = Gauge("calltap_calls_active", "Number of currently active recordings")
CALLS_STARTED = Counter(
    "calltap_calls_started_total",
    "Total number of recordings started",
    ["trigger", "service"],
)
CALLS_COMPLETED = Counter(
    "calltap_calls_completed_total",
    "Total number of recordings finished",
    ["status", "service"],
)
CALL_DURATION = Histogram(
    "calltap_call_duration_seconds",
    "Recorded call duration in seconds",
    ["service"],
    buckets=(5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600),
)
UPLOADS_TOTAL = Counter(
    "calltap_uploads_total",
    "Total cloud upload attempts by outcome",
    ["status"],
)
UPLOAD_DURATION = Histogram(
    "calltap_upload_duration_seconds",
    "Cloud upload duration in seconds",
    buckets=(0.5, 1, 2, 5, 10, 20, 45, 90, 180),
)
PENDING_UPLOADS = Gauge("calltap_pending_uploads", "Pending or retryable cloud uploads")
PULSE_HEALTHY = Gauge("calltap_pulse_healthy", "Whether PulseAudio daemon is reachable (1/0)")
BROWSER_EVENTS = Counter(
    "calltap_browser_events_total",
    "Client-side UI telemetry events ingested",
    ["source", "event", "level"],
)
HTTP_REQUESTS = Counter(
    "calltap_http_requests_total",
    "HTTP requests served by CallTap",
    ["method", "path", "status"],
)
HTTP_DURATION = Histogram(
    "calltap_http_request_duration_seconds",
    "HTTP request latency in seconds",
    ["method", "path"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5),
)

_STANDARD_RECORD_FIELDS = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)

_TELEMETRY_CONFIGURED_ENDPOINT: str | None = None
_HTTPX_INSTRUMENTED = False


class JsonLogFormatter(logging.Formatter):
    """Formats logs as single-line JSON with OTel trace_id/span_id correlation."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        span = trace.get_current_span()
        ctx = span.get_span_context() if span is not None else None
        if ctx is not None and ctx.is_valid:
            payload["trace_id"] = f"{ctx.trace_id:032x}"
            payload["span_id"] = f"{ctx.span_id:016x}"

        for key, val in record.__dict__.items():
            if key.startswith("_") or key in _STANDARD_RECORD_FIELDS:
                continue
            payload[key] = val

        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str)


def configure_logging(*, log_json: bool) -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not log_json:
        return

    formatter = JsonLogFormatter()
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(formatter)
        root.addHandler(handler)
    else:
        for handler in root.handlers:
            handler.setFormatter(formatter)

    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(logger_name)
        for handler in lg.handlers:
            handler.setFormatter(formatter)


def configure_telemetry(app: Any, settings: Settings) -> None:
    global _TELEMETRY_CONFIGURED_ENDPOINT, _HTTPX_INSTRUMENTED

    endpoint = settings.otlp_endpoint.strip()
    if endpoint and _TELEMETRY_CONFIGURED_ENDPOINT != endpoint:
        resource = Resource.create({"service.name": settings.service_name})
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=endpoint, timeout=5)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        _TELEMETRY_CONFIGURED_ENDPOINT = endpoint

    if not _HTTPX_INSTRUMENTED:
        HTTPXClientInstrumentor().instrument()
        _HTTPX_INSTRUMENTED = True

    if not getattr(app.state, "_otel_instrumented", False):
        FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,metrics")
        app.state._otel_instrumented = True


def start_span(name: str, attributes: dict[str, Any] | None = None) -> Any:
    try:
        tracer = trace.get_tracer("calltap")
        return tracer.start_as_current_span(name, attributes=attributes or {})
    except Exception:  # noqa: BLE001
        return nullcontext()
