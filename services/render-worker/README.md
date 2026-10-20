# Hendy FFmpeg worker

Separate Node.js 22 + FFmpeg container. It authenticates to the API with RENDER_SERVICE_TOKEN, claims a D1-backed lease, downloads only job-owner assets, renders MP4 and stores output in private R2.

On a trusted Docker host, transfer .env.render.local securely and run:

    docker compose --env-file .env.render.local -f docker-compose.render.yml up -d --build
    docker compose --env-file .env.render.local -f docker-compose.render.yml logs -f --tail=200

Security defaults: non-root user, read-only root filesystem, no extra Linux capabilities, no-new-privileges, bounded tmpfs, CPU/memory/pid limits, rotating logs, health check, and no published application port.

Current limits: 120 clips, 30-minute timeline, up to 3840x2160/60 FPS, 250 MiB aggregate source download and 80 MiB MP4 output. For larger files, implement direct-to-R2 resumable uploads before increasing limits. Load-test and failure-test the real FFmpeg pipeline before public launch.
