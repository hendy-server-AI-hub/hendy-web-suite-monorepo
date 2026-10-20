# Hendy Control Suite 2.0

A clean rewrite of this repository as a small, auditable production foundation. Active units: Cloudflare Worker API, Admin, Studio, public site, and an isolated FFmpeg render worker. The previous demo and placeholder implementations are removed from this source tree.

## Architecture

- apps/api: stateless Cloudflare Worker; authentication, D1, private R2, project manifests, render queue and request IDs.
- apps/admin-web: operational dashboard for API health, projects and assets.
- apps/studio-web: sign-in, uploads, timeline manifest, save-to-cloud and render job status/download.
- apps/site: public product landing page.
- services/render-worker: isolated non-root Docker service with FFmpeg; no public app port.
- scripts: rerunnable infrastructure bootstrap, admin bootstrap and production config validation.
- test: dependency-free Node test suite.

## Local checks

Requires Node.js 22 and npm 10+.

    npm run check

Run the API locally with Wrangler installed or through npx:

    npx wrangler dev --config apps/api/wrangler.toml

Static apps can be served by any static file server. Configure each app config.js with the local API URL first.

## Production bootstrap

Prerequisites: Git, Node.js 22+, GitHub CLI authenticated to the target repository, Docker on the render host, and a Cloudflare API token created by an account administrator. The API token needs Workers Scripts Edit, Pages Write, D1 Edit, R2 Storage Edit and access to Workers.dev subdomain settings.

    gh auth login
    npm install
    npm run bootstrap:production:push

The script validates the Cloudflare token, creates or reuses D1/R2/Pages, discovers or requests a workers.dev subdomain, generates application secrets, writes ignored local-only env files, declares GitHub Actions secrets and variables, and applies database migrations. It commits/pushes only the generated Worker config when requested.

Never commit or share .env.production.local or .env.render.local. GitHub secret values cannot be read back. Normal reruns preserve secrets from the local-only file and fail closed if a remote managed secret exists but its local value is missing. Deliberate rotation requires --rotate-secrets and typing ROTATE; JWT rotation invalidates sessions, and render-token rotation also requires secure distribution of the new env file to the render host.

After the API deploy succeeds, create the first owner account:

    npm run bootstrap:admin

On the trusted Docker render host, transfer .env.render.local securely, then run:

    docker compose --env-file .env.render.local -f docker-compose.render.yml up -d --build
    docker compose --env-file .env.render.local -f docker-compose.render.yml logs -f --tail=200

## Production checklist

Before public launch, configure account MFA, Cloudflare WAF/rate limits, backups and restore drills, billing budgets, log alerts, incident response, HTTPS custom domains, account recovery, security review, and end-to-end tests with real provider resources. Passing CI proves code checks/build consistency, not that Cloudflare has been provisioned. Browser sessions are short-lived and held in sessionStorage, so XSS prevention remains essential.
