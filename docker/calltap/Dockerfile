FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    pulseaudio-utils \
    rclone \
    && rm -rf /var/lib/apt/lists/*

# Match UID/GID 1000 of the neko container so the shared PulseAudio socket works cleanly.
RUN groupadd --gid 1000 calltap \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash calltap \
    && mkdir -p /data/calls /var/run/pulse /config/rclone \
    && chown -R calltap:calltap /data /var/run/pulse

WORKDIR /app
COPY pyproject.toml README.md ./
COPY calltap ./calltap
COPY docker/calltap/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && pip install --no-cache-dir .

EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["calltap", "serve"]
