# Production bootstrap and deployment

This is a production-oriented foundation, not a claim that every external service has already been deployed. Cloudflare secrets are not created from nothing: the bootstrap script needs an administrator-authorized Cloudflare API token and a GitHub CLI session. Do not paste credentials into chat or commit them.

## Prerequisites

- Node.js 22+, Git, Docker + Docker Compose, GitHub CLI (gh)
- gh auth login under an account that can push to main and write repository Actions secrets
- Cloudflare API token scoped to the intended account with Workers Scripts: Edit, D1: Edit and R2 Storage: Edit
- Cloudflare Account ID, public HTTPS application origins and the intended public Worker API URL
- A Docker host with network access to the Worker API to run FFmpeg

## Automated provisioning

From a local clone:

\`\`\`bash
npm install
npm run bootstrap:production:push
\`\`\`

The script prompts for the repository, Cloudflare Account ID, hidden Cloudflare token entry, HTTPS app origins and Worker API URL. It then:

1. Validates the Cloudflare API token.
2. Creates the D1 database hendy-suite-db and R2 bucket hendy-suite-assets if absent.
3. Generates independent cryptographic secrets for AUTH_JWT_SECRET, BOOTSTRAP_ADMIN_KEY and RENDER_SERVICE_TOKEN.
4. Writes real D1/R2 bindings and a CORS allowlist to apps/api/wrangler.toml.
5. Sets GitHub Actions secrets with gh secret set via stdin, not command-line arguments.
6. Writes ignored local-only .env.production.local and .env.render.local files with restrictive permissions; the Cloudflare API token is not written to disk.
7. Applies remote D1 migrations and, with the :push variant, commits/pushes only apps/api/wrangler.toml to main.

Required GitHub Actions secrets:
- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID
- AUTH_JWT_SECRET
- BOOTSTRAP_ADMIN_KEY
- RENDER_SERVICE_TOKEN

The Worker deploy workflow always builds and typechecks. It deploys only when all five secrets exist. After deployment, it sets AUTH_JWT_SECRET, BOOTSTRAP_ADMIN_KEY and RENDER_SERVICE_TOKEN inside Cloudflare Workers.

The first Cloudflare API token must be created by an account admin in Cloudflare and entered in the hidden terminal prompt; source code cannot create its own initial credential. The script fails if that token lacks D1, R2 or Worker permissions.

## Initial owner account

After the Worker has deployed:

\`\`\`bash
npm run bootstrap:admin
\`\`\`

The script defaults to the Worker URL saved in .env.production.local. Enter the owner email and a 12–128 character password twice; password input is hidden. The endpoint can create an owner only while the users table is empty, then returns HTTP 409 on later calls.

## FFmpeg render worker

Cloudflare Workers do not execute FFmpeg binaries, so the separate Docker service is used:

\`\`\`bash
npm run render:check
npm run render:up
npm run render:logs
\`\`\`

The bootstrap creates .env.render.local with the API URL and private RENDER_SERVICE_TOKEN. Run Compose on a trusted Docker host. The container uses a non-root user, a read-only root filesystem, bounded temp storage, CPU/memory/pid limits and log rotation; it does not publish a public HTTP port. A GitHub Actions workflow builds and publishes the render-worker image to GHCR when its source changes.

Render limits in this iteration: 120 clips, 30 minutes, 4K/60 FPS, 20 MiB per input, 250 MiB aggregate source download by default, and 80 MiB per MP4 output uploaded through the Worker. Larger outputs require direct-to-R2 upload rather than proxying through the Worker. D1 stores job leases and retry attempts. Each container processes one job at a time; run separate replicas with unique worker IDs for more capacity.

## Implemented authenticated API

- POST /api/v1/auth/bootstrap, POST /api/v1/auth/login, GET /api/v1/auth/me
- GET/POST /api/v1/projects and GET/PUT/DELETE /api/v1/projects/:uuid
- GET/POST /api/v1/assets and GET/DELETE /api/v1/assets/:uuid
- POST /api/v1/render/validate, POST/GET /api/v1/render/jobs, GET /api/v1/render/jobs/:uuid, POST /api/v1/render/jobs/:uuid/cancel, GET /api/v1/render/jobs/:uuid/download
- Internal authenticated worker endpoints under /internal/render/*

Project/asset endpoints use D1 and private R2. Viewer accounts are read-only. Password hashes use salted PBKDF2-HMAC-SHA256; API Bearer tokens are HS256 and expire after eight hours. Studio and Admin currently store the short-lived bearer token in browser localStorage, which makes XSS prevention an important production concern.

## Before exposing to the public

Configure Cloudflare rate limiting/WAF, monitoring/alerts, backup/restore tests, incident handling, account recovery/MFA and quota/billing controls. The Admin activity feed is demo data; real metrics, finance, user management and AI processing are not fully integrated. The original Flutter/Python/Windows installer source packages were not in the supplied archive and must be restored from their originals. Run a security review, end-to-end tests and verify actual Cloudflare deployment before calling the complete product production-ready.
