# Hendy Suite API (Cloudflare Workers)

## Routes

- `GET /healthz` — health probe.
- `GET /api/v1/health` — health probe with API prefix.
- `GET /api/v1/meta` — service metadata and supported starter features.
- `POST /api/v1/render/validate` — validates a render manifest shape; it does **not** start a render job.

## Local development

Run from repository root: `npm run dev:api`. Wrangler uses this folder's `wrangler.toml` and typically serves at `http://localhost:8787`.

For Studio integration, copy `apps/studio-web/.env.example` to `apps/studio-web/.env.local`; set `VITE_API_BASE_URL=http://localhost:8787`, then run `npm run dev:studio`. Studio calls `GET /api/v1/meta` to show Worker status and `POST /api/v1/render/validate` to validate its current timeline manifest.

The Studio draft is currently persisted to browser `localStorage`, not to this API. The validation endpoint deliberately does not create a render job or save a project.

## Deploy

The GitHub Actions deploy workflow uses `workingDirectory: apps/api`; it intentionally does not assume a root-level Worker entry file. Create `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets in GitHub Actions first.

## Production hardening checklist

- Restrict `CORS_ORIGIN` to the actual application origins. `*` is only a permissive starter value for public unauthenticated routes.
- Add authentication and authorization before exposing project, user, asset, wallet or admin APIs.
- Configure D1/R2/Queues with actual Cloudflare resource IDs and bindings; the starter does not persist projects or render jobs. Add authenticated project endpoints only after choosing and validating an identity/authentication mechanism.
- Add rate limiting, request size limits, observability, and integration tests before production workloads.
