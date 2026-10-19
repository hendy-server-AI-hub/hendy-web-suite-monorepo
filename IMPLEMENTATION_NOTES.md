# Hendy Web Suite — Studio stabilization notes

## What changed

- Separated the selected clip ID, selected asset, playhead time and playing state in Studio.
- Replaced the accidental clip-resize-on-click behavior with timeline selection/seeking.
- Added clip splitting at the playhead, plus Undo/Redo buttons and keyboard shortcuts (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Y`, `Ctrl/Cmd+Shift+Z`).
- Made timeline zoom affect content width and synchronized horizontal scrolling with the ruler.
- Made asset search/category filters work; subtitle visibility, color, outline, shadow and duck toggle now use React state instead of direct DOM class mutation.
- Added debounced local draft persistence in `localStorage`, including project title, clips, selection, playhead, zoom and subtitle options.
- Added a typed API client with a 10-second timeout, request IDs and readable errors. Studio checks `/api/v1/meta` and can validate its manifest against `/api/v1/render/validate`.
- Documented setup and current limitations in the root README and API README.

## Run locally

1. Copy `apps/studio-web/.env.example` to `apps/studio-web/.env.local`.
2. Install dependencies at repository root: `npm install`.
3. Run `npm run dev:api` and `npm run dev:studio` in separate terminals.
4. Open `http://localhost:5174`.

## Verified in this environment

- `node scripts/check-structure.mjs`: passed (17 required paths).
- TypeScript transpilation/syntax diagnostics for Studio `App.tsx`, Studio `api.ts`, API Worker and shared types: passed.
- API smoke tests for metadata, valid manifest validation, and invalid JSON handling: passed.
- CSS brace-balance check: passed.

A full `npm run typecheck` / Vite build has **not** been verified because dependency installation timed out and required type definitions (including Node and Vite) were unavailable in the environment.

## Not implemented yet

- Media upload, R2-backed asset library or real video/audio playback.
- Cloud project storage, user identity, authentication and authorization.
- Transform/audio settings written back to the render manifest.
- Actual render queue or MP4 generation via FFmpeg/render workers.

These remain separate implementation stages. The Studio API call validates manifest structure only; it does not save a cloud project or render video. Draft persistence is local to the current browser profile.
