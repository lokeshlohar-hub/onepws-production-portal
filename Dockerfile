# ONEPWS Production Portal — single-container image for Cloud Run.
# Runs the Node/Express backend (serves the API + static index.html) and the
# Python PDF-extractor sidecar (localhost:8082) in one container, matching the
# sys160 layout so EXTRACTOR_URL needs no change.
FROM node:20-slim

# Python for the extractor sidecar (PyMuPDF wheel needs no build tools on slim).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Cloudflare's connector, used only when PORTAL_DB_TUNNEL_HOST is set: it carries the database connection to the
# office PostgreSQL through the Cloudflare tunnel (see office-db/README.txt). Pinned version + SHA-256 published by
# Cloudflare for that release; the build fails if the download does not match.
ARG CLOUDFLARED_VERSION=2026.11.2
ARG CLOUDFLARED_SHA256=56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf
RUN curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    && echo "${CLOUDFLARED_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c - \
    && chmod +x /usr/local/bin/cloudflared

WORKDIR /app

# Backend deps first (layer cache).
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# Extractor deps in a venv (Debian blocks system-wide pip installs).
COPY extractor/requirements.txt ./extractor/
RUN python3 -m venv /opt/extractor-venv \
    && /opt/extractor-venv/bin/pip install --no-cache-dir -r extractor/requirements.txt

# App code. server.js serves the repo root statically, so index.html and the
# frontend helper scripts must sit at /app root, same as the repo layout.
COPY backend ./backend
COPY extractor ./extractor
COPY index.html dialog-helpers.js csv-import.js ./
# Tablet shell self-update feed: /tablet/latest.json + the APK itself.
COPY tablet ./tablet

# Cloud Run sends traffic to $PORT (default 8080). The extractor stays
# localhost-only inside the container, exactly like on sys160.
ENV NODE_ENV=production \
    EXTRACTOR_URL=http://127.0.0.1:8082

COPY docker-start.sh /docker-start.sh
RUN chmod +x /docker-start.sh
CMD ["/docker-start.sh"]
