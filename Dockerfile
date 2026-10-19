FROM python:3.12-slim-bookworm

# Proxy is injected by Compose build args, not baked into this image.
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates curl unzip ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL --connect-timeout 20 --retry 5 --retry-delay 3 --retry-all-errors \
       https://dl.google.com/android/repository/platform-tools-latest-linux.zip -o /tmp/platform-tools.zip \
    && unzip -q /tmp/platform-tools.zip -d /opt \
    && rm /tmp/platform-tools.zip
# Official, pinned scrcpy server only (no third-party builds or runtime auto-download).
# Include the matching upstream Apache-2.0 LICENSE in the distributed image.
# Digest taken from the upstream v5.0.1 release asset; fail the build if changed.
ARG SCRCPY_VERSION=5.0.1
RUN mkdir -p /opt/easyadb/scrcpy \
    && curl -fL --connect-timeout 20 --retry 5 --retry-delay 3 --retry-all-errors \
       "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1" \
       -o /opt/easyadb/scrcpy/server \
    && echo "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536  /opt/easyadb/scrcpy/server" | sha256sum -c - \
    && curl -fL --connect-timeout 20 --retry 5 --retry-delay 3 --retry-all-errors \
       "https://raw.githubusercontent.com/Genymobile/scrcpy/v5.0.1/LICENSE" \
       -o /opt/easyadb/scrcpy/LICENSE \
    && chmod 644 /opt/easyadb/scrcpy/server /opt/easyadb/scrcpy/LICENSE
ENV EASYADB_SCRCPY_SERVER=/opt/easyadb/scrcpy/server
ENV PATH="/opt/platform-tools:$PATH"
WORKDIR /app
COPY server/requirements.txt /app/server/requirements.txt
COPY server/requirements-webrtc.txt /app/server/requirements-webrtc.txt
RUN pip install --no-cache-dir --retries 5 --timeout 30 -r /app/server/requirements.txt \
    && pip install --no-cache-dir --retries 5 --timeout 90 -r /app/server/requirements-webrtc.txt
COPY server/ /app/server/
COPY web/ /app/web/
RUN mkdir -p /root/.android
EXPOSE 8000
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--ws", "wsproto"]
