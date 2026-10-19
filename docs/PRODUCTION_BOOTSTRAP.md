# Production provisioning

This repository provides a local bootstrap script to declare Cloudflare resources and GitHub Actions secrets. The first Cloudflare API token and GitHub CLI login must be supplied by a repository/account administrator; source code cannot create credentials without an existing authorized credential.

## Prerequisites

- Node.js 22+, Git and GitHub CLI (`gh`)
- `gh auth login` with permission to set repository Actions secrets and push to `main`
- A Cloudflare API token scoped to the target account with Workers Scripts: Edit, D1: Edit and R2 Storage: Edit
- Cloudflare Account ID and the real HTTPS origins of the deployed Admin/Studio/site

## Provision and deploy

From a clean local clone:

```bash
npm install
npm run bootstrap:production:push
```

The script asks for repository, Cloudflare Account ID, hidden Cloudflare token input and HTTPS origins. It creates D1 database `hendy-suite-db` and R2 bucket `hendy-suite-assets` when absent, generates `AUTH_JWT_SECRET` and `BOOTSTRAP_ADMIN_KEY`, declares four GitHub Actions secrets, updates `apps/api/wrangler.toml`, applies remote D1 migrations and pushes the config. Never commit or share `.env.production.local`; Git ignores this file and it only holds the generated application secrets.

Required GitHub Actions secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `AUTH_JWT_SECRET`
- `BOOTSTRAP_ADMIN_KEY`

After GitHub Actions deploys the Worker, run:

```bash
npm run bootstrap:admin
```

Enter the deployed Worker URL, owner email and a password (12–128 characters) in the prompts. The API allows this endpoint only while the users table is empty. Studio's account button opens the login dialog; upload requires a session.

## Endpoints implemented

- `POST /api/v1/auth/bootstrap` and `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `GET/POST /api/v1/projects` and `GET/PUT/DELETE /api/v1/projects/:uuid`
- `GET/POST /api/v1/assets` and `GET/DELETE /api/v1/assets/:uuid`
- Public health/meta and manifest validation endpoints

Studio uploads files to private R2 via the API (20 MiB maximum per file), saves project metadata/manifest in D1, and stores login token in the current browser's local storage. CORS allowlist must match the deployed app origins.

## Still required before a full production launch

MP4 render/FFmpeg worker is not implemented; a D1 table for render-job tracking is only a schema foundation. Also configure rate limiting/WAF, backups and restore tests, alerts, account recovery/MFA, quotas and monitoring. The admin dashboard has demo metrics and Flutter/Python/installer source packages are not included in the supplied starter; do not treat those parts as production-complete.
