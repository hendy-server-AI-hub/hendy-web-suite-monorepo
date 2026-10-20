# Production operations

## One-time infrastructure setup

Requirements: Node.js 22+, Git, GitHub CLI, Docker on the render host, and a Cloudflare API token created by a Cloudflare account administrator. Token scope must cover Workers Scripts edit, Pages write, D1 edit, R2 storage edit and Workers.dev subdomain settings.

Run from a clean checkout after reviewing/merging the rewrite to main:

    gh auth login
    npm install
    npm run bootstrap:production:push

The bootstrap creates/reuses the D1 database hendy-control-db, private R2 bucket hendy-control-assets, three Pages projects and a workers.dev API origin. It generates independent app secrets, configures GitHub Actions secrets/variables, writes D1/R2 bindings and the CORS origin allowlist, applies migrations and pushes only wrangler.toml when requested.

Secret values are not stored in source code or printed. The Cloudflare API token is passed to GitHub CLI via stdin and is not written to disk. Application secrets are saved locally in .env.production.local and .env.render.local with restrictive file permissions. Never commit/share those files. Normal reruns reuse local secrets and stop if a managed secret still exists on GitHub but the local backup was lost. Explicit secret rotation requires --rotate-secrets and typing ROTATE; JWT rotation invalidates current sessions, and render token rotation also requires secure file transfer to the render host.

## Initial account

After the Worker deploys successfully:

    npm run bootstrap:admin

The first owner requires a valid email and 12-128 character password. Bootstrap closes after the first user exists.

## Deploy and rendering

GitHub Actions on main performs CI, production config preflight, D1 migration, Worker deploy and secret binding. The Pages workflow builds static config.js from the non-secret VITE_API_BASE_URL variable and deploys Admin, Studio and Site.

Transfer .env.render.local securely to a trusted Docker host:

    docker compose --env-file .env.render.local -f docker-compose.render.yml up -d --build
    docker compose --env-file .env.render.local -f docker-compose.render.yml logs -f --tail=200

The worker runs non-root in a read-only container without published ports. It supports layered video/image clips plus audio tracks, 120 clips, 30 minutes, up to 4K/60 FPS, a configurable aggregate download cap (default 250 MiB), and output MP4 up to 80 MiB through the API. Larger renders should use direct-to-R2 multipart upload.

## Security and operations checklist

Before public launch, configure account MFA, WAF/rate limiting, budget alerts, data retention, backups and restore drills, monitor alerting and incident procedures. Run cross-account authorization tests, upload abuse tests, render failure injection, and end-to-end tests against real Cloudflare and Docker resources. CI passing does not prove provider credentials or production resources are ready. Browser sessions are held in sessionStorage to reduce persistence, but XSS remains a security risk and all frontend output should continue to use safe DOM APIs.
