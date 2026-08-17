# Kara — single always-warm container (sessions/guards/files are in-process;
# do NOT scale horizontally without externalizing state — see CLAUDE.md).
FROM node:22-slim

WORKDIR /app

# better-sqlite3 needs a build toolchain; ca-certificates for outbound TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Chromium + system deps for the full brain's browsing tools (demo mode never
# touches the browser and degrades gracefully if this layer is ever dropped).
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production PORT=8000
EXPOSE 8000

# transcripts/, deliverables/ and projects/ live on the Fly volume so applicant
# review trails and per-user build history survive redeploys; the app writes to
# repo-root paths, so symlink.
CMD ["sh", "-c", "mkdir -p /data/transcripts /data/deliverables /data/projects && ln -sfn /data/transcripts /app/transcripts && ln -sfn /data/deliverables /app/deliverables && ln -sfn /data/projects /app/projects && node server.js"]
