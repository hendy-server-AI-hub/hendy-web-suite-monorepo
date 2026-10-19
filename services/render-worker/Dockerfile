FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    FFMPEG_BIN=ffmpeg \
    HEALTH_PORT=8787 \
    TMPDIR=/tmp

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app /tmp/hendy-render \
 && chown -R node:node /app /tmp/hendy-render

WORKDIR /app
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node src ./src

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.mjs"]
