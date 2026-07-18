FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/eyeball-voice-worker

RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /build
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir ".[media]"

FROM python:3.12-slim AS runtime

ENV PATH="/opt/eyeball-voice-worker/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    EYEBALL_VOICE_DATABASE_PATH=/var/lib/eyeball/voice-worker.sqlite3 \
    PORT=8080

RUN groupadd --system eyeball \
    && useradd --system --gid eyeball --home-dir /var/lib/eyeball eyeball \
    && install --directory --owner=eyeball --group=eyeball /var/lib/eyeball

COPY --from=builder /opt/eyeball-voice-worker /opt/eyeball-voice-worker

USER eyeball
WORKDIR /var/lib/eyeball
VOLUME ["/var/lib/eyeball"]
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import json,urllib.request; body=json.load(urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)); assert body['status'] in {'ok','draining'}"]

STOPSIGNAL SIGTERM
CMD ["eyeball-voice-worker"]
