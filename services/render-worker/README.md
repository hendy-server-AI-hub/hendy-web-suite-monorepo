# Hendy FFmpeg render worker

This is a separate Node.js 22 + FFmpeg service, not part of Cloudflare Worker execution. It polls the Hendy API using an independent RENDER_SERVICE_TOKEN, claims one queued job, downloads job-owner assets through a protected internal route, renders MP4 and uploads the result to private R2.

## Run

The production bootstrap creates the local-only .env.render.local file. Do not commit or share it.

\`\`\`bash
npm run render:check
npm run render:up
npm run render:logs
\`\`\`

Or run Compose explicitly:

\`\`\`bash
docker compose --env-file .env.render.local -f docker-compose.render.yml up -d --build
\`\`\`

Security defaults include non-root user, read-only root filesystem, no extra Linux capabilities, no-new-privileges, bounded tmpfs, CPU/memory/pid limits, rotating JSON logs, health check and restart policy. No public application port is exposed.

## Render contract and limits

- D1-backed polling queue; claim leases expire after 10 minutes and worker failures retry up to three attempts.
- 120 clips maximum, 30-minute duration, up to 4K/60 FPS.
- Source media: 20 MiB per upload and 250 MiB aggregate download by default.
- MP4: 80 MiB output cap because bytes pass through the Worker API on the way to private R2.
- Layered video/image clips, audio tracks and SRT/VTT subtitle cues are supported in this initial pipeline.
- One active job per container; use distinct worker IDs for additional replicas.

For larger files, replace the Worker-proxied file path with R2 multipart/presigned upload and direct R2 access. Production hardening still requires load testing, failure injection, FFmpeg resource tuning, quotas, cancellation of active jobs, backup/restore tests and monitoring.
