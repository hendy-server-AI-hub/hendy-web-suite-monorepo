import type { ApiError, ApiMeta, RenderManifest, AppRole, ProjectStatus } from "@hendy/shared-types";

interface D1Result<T = unknown> { success: boolean; results?: T[]; meta?: { changes?: number; last_row_id?: number; duration?: number }; }
interface D1Statement { bind(...values: unknown[]): D1Statement; first<T = Record<string, unknown>>(): Promise<T | null>; all<T = Record<string, unknown>>(): Promise<D1Result<T>>; run(): Promise<D1Result>; }
interface D1Database { prepare(query: string): D1Statement; }
interface StoredObject { body: ReadableStream<Uint8Array>; httpEtag?: string; writeHttpMetadata(headers: Headers): void; }
interface R2Bucket { put(key: string, value: ArrayBuffer | ReadableStream<Uint8Array>, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<{ etag?: string }>; get(key: string): Promise<StoredObject | null>; delete(key: string): Promise<void>; }
interface Env { APP_NAME?: string; APP_VERSION?: string; APP_ENV?: string; CORS_ORIGIN?: string; AUTH_JWT_SECRET?: string; BOOTSTRAP_ADMIN_KEY?: string; RENDER_SERVICE_TOKEN?: string; DB?: D1Database; ASSETS?: R2Bucket; }
interface UserRow { id: string; email: string; role: AppRole; status: string; password_salt?: string; password_hash?: string; }
interface ProjectRow { id: string; owner_id: string; name: string; status: ProjectStatus; manifest_json: string | null; created_at: string; updated_at: string; }
interface AssetRow { id: string; owner_id: string; name: string; mime_type: string; size_bytes: number; r2_key: string; created_at: string; }
interface RenderJobRow { id: string; owner_id: string; project_id: string; status: string; progress: number; output_key: string | null; output_size_bytes?: number | null; error_code: string | null; error_message: string | null; attempts: number; lease_until?: number | null; worker_id?: string | null; created_at: string; updated_at: string; started_at?: string | null; finished_at?: string | null; project_name?: string; manifest_json?: string | null; }
interface Claims { sub: string; email: string; role: AppRole; iat: number; exp: number; }

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" };
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const MAX_JSON_BYTES = 1_048_576;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_RENDER_OUTPUT_BYTES = 80 * 1024 * 1024;
const MAX_RENDER_CLIPS = 120;
const MAX_RENDER_DURATION_SECONDS = 1800;
const MAX_RENDER_ATTEMPTS = 3;
const RENDER_LEASE_SECONDS = 600;
const PBKDF2_ITERATIONS = 150_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function newId(): string { return crypto.randomUUID(); }
function toBase64Url(value: Uint8Array): string { let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function fromBase64Url(value: string): Uint8Array { const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); const binary = atob(base64); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response { return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } }); }
function fail(code: string, message: string, requestId: string, status: number, headers: Record<string, string>): Response { const body: ApiError = { error: { code, message, requestId } }; return json(body, status, headers); }
function originAllowed(origin: string, env: Env): boolean { const allowed = (env.CORS_ORIGIN || "http://localhost:5173,http://localhost:5174").split(",").map((v) => v.trim()).filter(Boolean); return allowed.includes("*") || allowed.includes(origin); }
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.CORS_ORIGIN || "http://localhost:5173,http://localhost:5174").split(",").map((v) => v.trim()).filter(Boolean);
  return { "access-control-allow-origin": allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : "null"), "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-request-id,x-bootstrap-key", "access-control-max-age": "86400", "vary": "Origin" };
}
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
async function readJson(request: Request): Promise<{ value: unknown } | { error: string; status: number }> {
  if (Number(request.headers.get("content-length") || "0") > MAX_JSON_BYTES) return { error: "JSON body vượt quá giới hạn 1 MB.", status: 413 };
  try { const raw = await request.text(); if (encoder.encode(raw).byteLength > MAX_JSON_BYTES) return { error: "JSON body vượt quá giới hạn 1 MB.", status: 413 }; return { value: JSON.parse(raw) as unknown }; }
  catch { return { error: "Request body phải là JSON hợp lệ.", status: 400 }; }
}
function equalConstantTime(a: string, b: string): boolean { const left = encoder.encode(a); const right = encoder.encode(b); let mismatch = left.length ^ right.length; const length = Math.max(left.length, right.length); for (let i = 0; i < length; i++) mismatch |= (left[i] || 0) ^ (right[i] || 0); return mismatch === 0; }
function arrayBufferCopy(value: Uint8Array): ArrayBuffer { const copy = new Uint8Array(value.byteLength); copy.set(value); return copy.buffer; }
async function passwordHash(password: string, salt: Uint8Array): Promise<Uint8Array> { const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]); const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: arrayBufferCopy(salt), iterations: PBKDF2_ITERATIONS }, material, 256); return new Uint8Array(bits); }
async function signingKey(secret: string): Promise<CryptoKey> { return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
async function issueToken(user: Pick<UserRow, "id" | "email" | "role">, secret: string): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000); const claims: Claims = { sub: user.id, email: user.email, role: user.role, iat: now, exp: now + TOKEN_TTL_SECONDS };
  const head = toBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = head + "." + body;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(signingInput)));
  return { token: signingInput + "." + toBase64Url(signature), expiresAt: new Date(claims.exp * 1000).toISOString() };
}
async function verifyToken(token: string, secret: string): Promise<Claims | null> {
  const parts = token.split("."); if (parts.length !== 3) return null;
  try { const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), arrayBufferCopy(fromBase64Url(parts[2])), encoder.encode(parts[0] + "." + parts[1])); if (!valid) return null;
    const claims = JSON.parse(decoder.decode(fromBase64Url(parts[1]))) as Partial<Claims>;
    if (typeof claims.sub !== "string" || typeof claims.email !== "string" || typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000) || !["owner", "admin", "editor", "viewer"].includes(String(claims.role))) return null;
    return claims as Claims;
  } catch { return null; }
}
async function authenticate(request: Request, env: Env): Promise<Claims | null> {
  if (!env.AUTH_JWT_SECRET || !env.DB) return null;
  const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i); if (!match) return null;
  const claims = await verifyToken(match[1], env.AUTH_JWT_SECRET); if (!claims) return null;
  const user = await env.DB.prepare("SELECT id,email,role,status FROM users WHERE id = ? LIMIT 1").bind(claims.sub).first<UserRow>();
  return user && user.status === "active" && user.email === claims.email && user.role === claims.role ? claims : null;
}
function validateManifest(input: unknown): { valid: true; manifest: RenderManifest } | { valid: false; reason: string } {
  const data = asRecord(input); if (!data) return { valid: false, reason: "Body phải là JSON object." };
  if (data.version !== 1) return { valid: false, reason: "manifest.version phải bằng 1." };
  if (typeof data.projectId !== "string" || data.projectId.trim().length < 1 || data.projectId.length > 128) return { valid: false, reason: "projectId không hợp lệ." };
  const output = asRecord(data.output);
  if (!output || !Number.isInteger(output.width) || !Number.isInteger(output.height) || typeof output.fps !== "number" || !Number.isFinite(output.fps) || output.format !== "mp4") return { valid: false, reason: "output cần width, height, fps và format=mp4 hợp lệ." };
  if ((output.width as number) < 160 || (output.width as number) > 7680 || (output.height as number) < 160 || (output.height as number) > 4320 || (output.fps as number) < 1 || (output.fps as number) > 120) return { valid: false, reason: "Thông số xuất video nằm ngoài giới hạn cho phép." };
  if (!Array.isArray(data.tracks) || data.tracks.length > 64) return { valid: false, reason: "tracks phải là mảng tối đa 64 track." };
  const trackIds = new Set<string>(); const clipIds = new Set<string>();
  for (const unknownTrack of data.tracks) {
    const track = asRecord(unknownTrack);
    if (!track || typeof track.id !== "string" || !track.id || !["video", "audio", "subtitle"].includes(String(track.kind)) || !Array.isArray(track.clips)) return { valid: false, reason: "Cấu trúc track không hợp lệ." };
    if (trackIds.has(track.id)) return { valid: false, reason: "Track ID không được trùng nhau." }; trackIds.add(track.id);
    if (track.clips.length > 5000) return { valid: false, reason: "Mỗi track không được vượt quá 5000 clip." };
    for (const unknownClip of track.clips) {
      const clip = asRecord(unknownClip);
      if (!clip || typeof clip.id !== "string" || !clip.id || typeof clip.assetId !== "string" || !clip.assetId || typeof clip.start !== "number" || !Number.isFinite(clip.start) || typeof clip.duration !== "number" || !Number.isFinite(clip.duration) || clip.start < 0 || clip.duration <= 0) return { valid: false, reason: "Clip chứa ID, tài nguyên, thời điểm hoặc thời lượng không hợp lệ." };
      if (clipIds.has(clip.id)) return { valid: false, reason: "Clip ID không được trùng nhau trong manifest." }; clipIds.add(clip.id);
    }
  }
  return { valid: true, manifest: data as unknown as RenderManifest };
}
function validEmail(email: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function safeFileName(input: string): string { const basename = input.replace(/\\/g, "/").split("/").pop() || "upload"; return basename.replace(/[^\w.\- ()\u00A0-\u024F]/g, "_").slice(0, 180) || "upload"; }
function allowedMime(mime: string): boolean { return /^(video\/(mp4|webm|quicktime|x-matroska)|audio\/(mpeg|mp4|wav|x-wav|ogg|webm|flac|aac)|text\/(plain|vtt)|application\/(x-subrip|vnd.apple.mpegurl)|image\/(jpeg|png|webp))$/i.test(mime); }

async function route(request: Request, env: Env, requestId: string, headers: Record<string, string>): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname.replace(/\/+$/, "") || "/"; const method = request.method.toUpperCase();
  if (method === "GET" && (path === "/healthz" || path === "/api/v1/health")) {
    return json({ status: "ok", service: env.APP_NAME || "Hendy Suite API", version: env.APP_VERSION || "1.0.0", environment: env.APP_ENV || "development", capabilities: { databaseConfigured: !!env.DB, objectStorageConfigured: !!env.ASSETS, authenticationConfigured: !!env.AUTH_JWT_SECRET }, timestamp: new Date().toISOString(), requestId }, 200, headers);
  }
  if (method === "GET" && path === "/api/v1/meta") {
    const data: ApiMeta = { name: env.APP_NAME || "Hendy Suite API", version: env.APP_VERSION || "1.0.0", environment: env.APP_ENV || "development", features: ["health-check", "manifest-validation", ...(env.DB ? ["user-auth", "project-storage"] : []), ...(env.DB && env.ASSETS ? ["asset-library"] : [])] };
    return json(data, 200, headers);
  }

  if (path === "/api/v1/auth/bootstrap" && method === "POST") {
    if (!env.DB || !env.AUTH_JWT_SECRET || !env.BOOTSTRAP_ADMIN_KEY) return fail("AUTH_NOT_CONFIGURED", "Database hoặc secret xác thực chưa được cấu hình.", requestId, 503, headers);
    if (!equalConstantTime(request.headers.get("x-bootstrap-key") || "", env.BOOTSTRAP_ADMIN_KEY)) return fail("BOOTSTRAP_FORBIDDEN", "Bootstrap key không hợp lệ.", requestId, 403, headers);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
    if ((count?.count || 0) > 0) return fail("BOOTSTRAP_CLOSED", "Tài khoản đầu tiên đã được tạo; bootstrap đã bị khóa.", requestId, 409, headers);
    const parsed = await readJson(request); if ("error" in parsed) return fail("INVALID_JSON", parsed.error, requestId, parsed.status, headers);
    const body = asRecord(parsed.value); const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""; const password = typeof body?.password === "string" ? body.password : "";
    if (!validEmail(email)) return fail("INVALID_EMAIL", "Email không hợp lệ.", requestId, 422, headers);
    if (password.length < 12 || password.length > 128) return fail("WEAK_PASSWORD", "Mật khẩu phải dài từ 12 đến 128 ký tự.", requestId, 422, headers);
    const userId = newId(); const salt = crypto.getRandomValues(new Uint8Array(16)); const hash = await passwordHash(password, salt);
    const inserted = await env.DB.prepare("INSERT INTO users (id,email,password_salt,password_hash,role,status) SELECT ?,?,?,?,'owner','active' WHERE NOT EXISTS (SELECT 1 FROM users)").bind(userId, email, toBase64Url(salt), toBase64Url(hash)).run();
    if ((inserted.meta?.changes || 0) !== 1) return fail("BOOTSTRAP_CLOSED", "Tài khoản đầu tiên đã được tạo; bootstrap đã bị khóa.", requestId, 409, headers);
    const session = await issueToken({ id: userId, email, role: "owner" }, env.AUTH_JWT_SECRET);
    return json({ token: session.token, tokenType: "Bearer", expiresAt: session.expiresAt, user: { id: userId, email, role: "owner" } }, 201, headers);
  }
  if (path === "/api/v1/auth/login" && method === "POST") {
    if (!env.DB || !env.AUTH_JWT_SECRET) return fail("AUTH_NOT_CONFIGURED", "Database hoặc secret xác thực chưa được cấu hình.", requestId, 503, headers);
    const parsed = await readJson(request); if ("error" in parsed) return fail("INVALID_JSON", parsed.error, requestId, parsed.status, headers);
    const body = asRecord(parsed.value); const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""; const password = typeof body?.password === "string" ? body.password : "";
    if (!validEmail(email) || !password || password.length > 128) return fail("INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng.", requestId, 401, headers);
    const user = await env.DB.prepare("SELECT id,email,role,status,password_salt,password_hash FROM users WHERE email = ? LIMIT 1").bind(email).first<UserRow>();
    if (!user || user.status !== "active" || !user.password_salt || !user.password_hash) return fail("INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng.", requestId, 401, headers);
    const candidate = await passwordHash(password, fromBase64Url(user.password_salt));
    if (!equalConstantTime(toBase64Url(candidate), user.password_hash)) return fail("INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng.", requestId, 401, headers);
    const session = await issueToken({ id: user.id, email: user.email, role: user.role }, env.AUTH_JWT_SECRET);
    return json({ token: session.token, tokenType: "Bearer", expiresAt: session.expiresAt, user: { id: user.id, email: user.email, role: user.role } }, 200, headers);
  }

  if (method === "POST" && path === "/api/v1/render/validate") {
    const parsed = await readJson(request);
    if ("error" in parsed) return fail("INVALID_JSON", parsed.error, requestId, parsed.status, headers);
    const checked = validateManifest(parsed.value);
    if (!checked.valid) return fail("INVALID_MANIFEST", checked.reason, requestId, 422, headers);
    return json({
      valid: true,
      projectId: checked.manifest.projectId,
      trackCount: checked.manifest.tracks.length,
      clipCount: checked.manifest.tracks.reduce((total, track) => total + track.clips.length, 0),
      note: "Manifest structure is valid. Render only starts through POST /api/v1/render/jobs.",
    }, 200, headers);
  }

  if (path.startsWith("/internal/render/")) {
    if (!env.RENDER_SERVICE_TOKEN) return fail("RENDER_SERVICE_NOT_CONFIGURED", "RENDER_SERVICE_TOKEN chưa được cấu hình.", requestId, 503, headers);
    const authorization = request.headers.get("authorization") || "";
    const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (!tokenMatch || !equalConstantTime(tokenMatch[1], env.RENDER_SERVICE_TOKEN)) return fail("RENDER_SERVICE_UNAUTHORIZED", "Render service token không hợp lệ.", requestId, 401, headers);
    if (!env.DB) return fail("DATABASE_NOT_CONFIGURED", "D1 chưa được khai báo.", requestId, 503, headers);
    const workerId = request.headers.get("x-render-worker-id") || "";
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(workerId)) return fail("INVALID_RENDER_WORKER", "Thiếu hoặc sai x-render-worker-id.", requestId, 400, headers);

    if (method === "GET" && path === "/internal/render/jobs/next") {
      if (!env.ASSETS) return fail("OBJECT_STORAGE_NOT_CONFIGURED", "R2 chưa được khai báo.", requestId, 503, headers);
      const now = Math.floor(Date.now() / 1000);
      const nowIso = new Date().toISOString();
      await env.DB.prepare("UPDATE render_jobs SET status='failed',error_code='WORKER_TIMEOUT',error_message='Render worker lease expired too many times.',lease_until=NULL,worker_id=NULL,finished_at=?,updated_at=? WHERE status='processing' AND lease_until <= ? AND attempts >= ?")
        .bind(nowIso, nowIso, now, MAX_RENDER_ATTEMPTS).run();
      const candidate = await env.DB.prepare("SELECT r.id,r.owner_id,r.project_id,r.status,r.attempts,r.lease_until,p.manifest_json,p.name AS project_name FROM render_jobs r JOIN projects p ON p.id=r.project_id WHERE p.manifest_json IS NOT NULL AND r.attempts < ? AND (r.status='queued' OR (r.status='processing' AND r.lease_until <= ?)) ORDER BY r.created_at ASC LIMIT 1")
        .bind(MAX_RENDER_ATTEMPTS, now).first<RenderJobRow>();
      if (!candidate) return json({ job: null, pollAfterMs: 2000 }, 200, headers);
      const updated = await env.DB.prepare("UPDATE render_jobs SET status='processing',progress=1,attempts=attempts+1,worker_id=?,lease_until=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND attempts < ? AND (status='queued' OR (status='processing' AND lease_until <= ?))")
        .bind(workerId, now + RENDER_LEASE_SECONDS, nowIso, nowIso, candidate.id, MAX_RENDER_ATTEMPTS, now).run();
      if ((updated.meta?.changes || 0) !== 1) return json({ job: null, pollAfterMs: 1000 }, 200, headers);
      const manifestJson = candidate.manifest_json;
      if (!manifestJson) {
        await env.DB.prepare("UPDATE render_jobs SET status='failed',error_code='MISSING_MANIFEST',error_message='Project manifest is empty.',finished_at=?,updated_at=?,lease_until=NULL,worker_id=NULL WHERE id=? AND worker_id=?")
          .bind(nowIso, nowIso, candidate.id, workerId).run();
        return json({ job: null, pollAfterMs: 250 }, 200, headers);
      }
      let manifest: RenderManifest;
      try { manifest = JSON.parse(manifestJson) as RenderManifest; }
      catch {
        await env.DB.prepare("UPDATE render_jobs SET status='failed',error_code='INVALID_MANIFEST_JSON',error_message='Stored project manifest is not valid JSON.',finished_at=?,updated_at=?,lease_until=NULL,worker_id=NULL WHERE id=? AND worker_id=?")
          .bind(nowIso, nowIso, candidate.id, workerId).run();
        return json({ job: null, pollAfterMs: 250 }, 200, headers);
      }
      return json({ job: { id: candidate.id, projectId: candidate.project_id, projectName: candidate.project_name, attempt: (candidate.attempts || 0) + 1, manifest } }, 200, headers);
    }

    const assetMatch = path.match(/^\/internal\/render\/assets\/([0-9a-f-]{36})$/i);
    if (assetMatch && method === "GET") {
      const jobId = url.searchParams.get("jobId") || "";
      const job = await env.DB.prepare("SELECT id,owner_id,status,worker_id FROM render_jobs WHERE id=? LIMIT 1").bind(jobId).first<RenderJobRow>();
      if (!job || job.status !== "processing" || job.worker_id !== workerId) return fail("RENDER_JOB_LEASE_INVALID", "Render job lease không hợp lệ hoặc đã hết hạn.", requestId, 409, headers);
      const asset = await env.DB.prepare("SELECT id,owner_id,name,mime_type,size_bytes,r2_key,created_at FROM assets WHERE id=? AND owner_id=? LIMIT 1")
        .bind(assetMatch[1], job.owner_id).first<AssetRow>();
      if (!asset) return fail("ASSET_NOT_FOUND", "Tài nguyên không thuộc project owner.", requestId, 404, headers);
      if (!env.ASSETS) return fail("OBJECT_STORAGE_NOT_CONFIGURED", "R2 chưa được khai báo.", requestId, 503, headers);
      const object = await env.ASSETS.get(asset.r2_key);
      if (!object) return fail("ASSET_OBJECT_MISSING", "File tài nguyên không còn trong R2.", requestId, 404, headers);
      const assetHeaders = new Headers(headers);
      object.writeHttpMetadata(assetHeaders);
      assetHeaders.set("content-type", asset.mime_type);
      assetHeaders.set("content-disposition", "inline; filename*=UTF-8''" + encodeURIComponent(asset.name));
      assetHeaders.set("x-asset-name", encodeURIComponent(asset.name));
      assetHeaders.set("cache-control", "private, no-store");
      if (object.httpEtag) assetHeaders.set("etag", object.httpEtag);
      return new Response(object.body, { status: 200, headers: assetHeaders });
    }

    const jobMatch = path.match(/^\/internal\/render\/jobs\/([0-9a-f-]{36})(?:\/(progress|output|fail))?$/i);
    if (jobMatch) {
      const jobId = jobMatch[1];
      const action = jobMatch[2] || "";
      const job = await env.DB.prepare("SELECT id,owner_id,project_id,status,progress,output_key,attempts,worker_id FROM render_jobs WHERE id=? LIMIT 1").bind(jobId).first<RenderJobRow>();
      if (!job || job.status !== "processing" || job.worker_id !== workerId) return fail("RENDER_JOB_LEASE_INVALID", "Render job lease không hợp lệ hoặc đã hết hạn.", requestId, 409, headers);

      if (action === "progress" && method === "POST") {
        const parsed = await readJson(request);
        if ("error" in parsed) return fail("INVALID_JSON", parsed.error, requestId, parsed.status, headers);
        const body = asRecord(parsed.value);
        const progress = body?.progress;
        if (typeof progress !== "number" || !Number.isInteger(progress) || progress < 1 || progress > 99) return fail("INVALID_PROGRESS", "progress phải là số nguyên từ 1 đến 99.", requestId, 422, headers);
        const now = Math.floor(Date.now() / 1000);
        const updated = await env.DB.prepare("UPDATE render_jobs SET progress=?,lease_until=?,updated_at=? WHERE id=? AND status='processing' AND worker_id=?")
          .bind(progress, now + RENDER_LEASE_SECONDS, new Date().toISOString(), jobId, workerId).run();
        if ((updated.meta?.changes || 0) !== 1) return fail("RENDER_JOB_LEASE_INVALID", "Render job lease đã hết hạn.", requestId, 409, headers);
        return json({ updated: true, progress }, 200, headers);
      }

      if (action === "fail" && method === "POST") {
        const parsed = await readJson(request);
        if ("error" in parsed) return fail("INVALID_JSON", parsed.error, requestId, parsed.status, headers);
        const body = asRecord(parsed.value);
        const code = typeof body?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(body.code) ? body.code : "RENDER_FAILED";
        const message = typeof body?.message === "string" && body.message.trim() ? body.message.trim().slice(0, 300) : "Render worker reported a failure.";
        const retry = job.attempts < MAX_RENDER_ATTEMPTS;
        const nowIso = new Date().toISOString();
        await env.DB.prepare("UPDATE render_jobs SET status=?,progress=CASE WHEN ?='queued' THEN 0 ELSE progress END,error_code=?,error_message=?,lease_until=NULL,worker_id=NULL,finished_at=CASE WHEN ?='failed' THEN ? ELSE NULL END,updated_at=? WHERE id=? AND status='processing' AND worker_id=?")
          .bind(retry ? "queued" : "failed", retry ? "queued" : "failed", code, message, retry ? "queued" : "failed", nowIso, nowIso, jobId, workerId).run();
        return json({ accepted: true, retrying: retry, attempt: job.attempts }, 200, headers);
      }

      if (action === "output" && (method === "PUT" || method === "POST")) {
        if (!env.ASSETS) return fail("OBJECT_STORAGE_NOT_CONFIGURED", "R2 chưa được khai báo.", requestId, 503, headers);
        const contentLength = Number(request.headers.get("content-length") || "0");
        if (!Number.isFinite(contentLength) || contentLength <= 0) return fail("CONTENT_LENGTH_REQUIRED", "Render worker phải gửi Content-Length cho MP4.", requestId, 411, headers);
        if (contentLength > MAX_RENDER_OUTPUT_BYTES) return fail("RENDER_OUTPUT_TOO_LARGE", "Giới hạn MP4 output qua API hiện tại là 80 MiB; cấu hình direct-to-R2 cho output lớn hơn.", requestId, 413, headers);
        if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("video/mp4") || !request.body) return fail("INVALID_RENDER_OUTPUT", "Output phải là stream video/mp4.", requestId, 415, headers);
        const key = "renders/" + job.owner_id + "/" + jobId + ".mp4";
        try {
          await env.ASSETS.put(key, request.body, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { ownerId: job.owner_id, jobId, contentType: "video/mp4" } });
          const nowIso = new Date().toISOString();
          const updated = await env.DB.prepare("UPDATE render_jobs SET status='completed',progress=100,output_key=?,output_size_bytes=?,error_code=NULL,error_message=NULL,lease_until=NULL,worker_id=NULL,finished_at=?,updated_at=? WHERE id=? AND status='processing' AND worker_id=?")
            .bind(key, contentLength, nowIso, nowIso, jobId, workerId).run();
          if ((updated.meta?.changes || 0) !== 1) {
            await env.ASSETS.delete(key).catch(() => undefined);
            return fail("RENDER_JOB_LEASE_INVALID", "Render job lease đã hết hạn trước khi hoàn tất upload.", requestId, 409, headers);
          }
          return json({ completed: true, jobId, outputSizeBytes: contentLength }, 200, headers);
        } catch (error) {
          await env.ASSETS.delete(key).catch(() => undefined);
          console.error(JSON.stringify({ event: "render_output_upload_failed", requestId, jobId, error: error instanceof Error ? error.message : "unknown" }));
          return fail("RENDER_OUTPUT_UPLOAD_FAILED", "Không thể lưu MP4 vào R2.", requestId, 500, headers);
        }
      }
      return fail("NOT_FOUND", "Không tìm thấy internal render endpoint.", requestId, 404, headers);
    }
    return fail("NOT_FOUND", "Không tìm thấy internal render endpoint.", requestId, 404, headers);
  }

  if (path.startsWith("/api/v1/projects") || path.startsWith("/api/v1/assets") || path.startsWith("/api/v1/render/jobs") || path === "/api/v1/auth/me") {
    if (!env.DB) return fail("DATABASE_NOT_CONFIGURED", "D1 chưa được khai báo. Chạy npm run bootstrap:production.", requestId, 503, headers);
    if (!env.AUTH_JWT_SECRET) return fail("AUTH_NOT_CONFIGURED", "AUTH_JWT_SECRET chưa được khai báo.", requestId, 503, headers);
    const user = await authenticate(request, env); if (!user) return fail("UNAUTHENTICATED", "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.", requestId, 401, headers);
    if (path === "/api/v1/auth/me" && method === "GET") return json({ user: { id: user.sub, email: user.email, role: user.role }, expiresAt: new Date(user.exp * 1000).toISOString() }, 200, headers);


    if (path === "/api/v1/render/jobs" && method === "POST") {
      if (!env.ASSETS || !env.RENDER_SERVICE_TOKEN) return fail("RENDER_NOT_CONFIGURED", "R2 hoặc render service token chưa được khai báo.", requestId, 503, headers);
      if (user.role === "viewer") return fail("ROLE_FORBIDDEN", "Tài khoản viewer không được tạo render.", requestId, 403, headers);
      const parsed = await readJson(request);
      if ("error" in parsed) return fail("INVALID_JSON", parsed.error, requestId, parsed.status, headers);
      const body = asRecord(parsed.value);
      const projectId = typeof body?.projectId === "string" ? body.projectId : "";
      if (!/^[0-9a-f-]{36}$/i.test(projectId)) return fail("INVALID_PROJECT_ID", "projectId phải là UUID của dự án cloud.", requestId, 422, headers);
      const project = await env.DB.prepare("SELECT id,owner_id,name,status,manifest_json,created_at,updated_at FROM projects WHERE id=? AND owner_id=? LIMIT 1")
        .bind(projectId, user.sub).first<ProjectRow>();
      if (!project) return fail("PROJECT_NOT_FOUND", "Không tìm thấy dự án hoặc bạn không có quyền.", requestId, 404, headers);
      if (!project.manifest_json) return fail("MANIFEST_REQUIRED", "Hãy lưu manifest của dự án lên cloud trước khi render.", requestId, 422, headers);
      let rawManifest: unknown;
      try { rawManifest = JSON.parse(project.manifest_json) as unknown; } catch { return fail("INVALID_MANIFEST_JSON", "Manifest đã lưu không phải JSON hợp lệ.", requestId, 422, headers); }
      const checked = validateManifest(rawManifest);
      if (!checked.valid) return fail("INVALID_MANIFEST", checked.reason, requestId, 422, headers);
      if (checked.manifest.projectId !== projectId) return fail("PROJECT_ID_MISMATCH", "Manifest projectId không khớp ID cloud.", requestId, 422, headers);
      const clipList = checked.manifest.tracks.flatMap((track) => track.clips.map((clip) => ({ ...clip, kind: track.kind })));
      if (!clipList.length || clipList.length > MAX_RENDER_CLIPS) return fail("RENDER_CLIP_LIMIT", "Render cần từ 1 đến " + MAX_RENDER_CLIPS + " clip.", requestId, 422, headers);
      const totalDuration = Math.max(0, ...clipList.map((clip) => clip.start + clip.duration));
      if (totalDuration <= 0 || totalDuration > MAX_RENDER_DURATION_SECONDS) return fail("RENDER_DURATION_LIMIT", "Thời lượng render tối đa là 30 phút.", requestId, 422, headers);
      if (checked.manifest.output.width > 3840 || checked.manifest.output.height > 2160 || checked.manifest.output.fps > 60) return fail("RENDER_SPEC_LIMIT", "Render API giới hạn ở 4K/60 FPS để bảo vệ tài nguyên.", requestId, 422, headers);
      const assetIds = [...new Set(clipList.map((clip) => clip.assetId))];
      const placeholders = assetIds.map(() => "?").join(",");
      const rows = await env.DB.prepare("SELECT id FROM assets WHERE owner_id=? AND id IN (" + placeholders + ")").bind(user.sub, ...assetIds).all<{ id: string }>();
      const owned = new Set((rows.results || []).map((asset) => asset.id));
      if (assetIds.some((assetId) => !owned.has(assetId))) return fail("ASSET_ACCESS_DENIED", "Tất cả clip phải trỏ tới tài nguyên R2 thuộc tài khoản này.", requestId, 422, headers);
      const jobId = newId();
      await env.DB.prepare("INSERT INTO render_jobs (id,owner_id,project_id,status,progress,attempts) VALUES (?,?,?,'queued',0,0)")
        .bind(jobId, user.sub, projectId).run();
      const job = await env.DB.prepare("SELECT id,project_id,status,progress,attempts,created_at,updated_at FROM render_jobs WHERE id=? AND owner_id=?")
        .bind(jobId, user.sub).first<RenderJobRow>();
      return json({ job: { ...job, projectName: project.name, downloadUrl: null }, message: "Render job đã được đưa vào hàng đợi. Worker FFmpeg sẽ xử lý khi sẵn sàng." }, 202, headers);
    }
    if (path === "/api/v1/render/jobs" && method === "GET") {
      const result = await env.DB.prepare("SELECT r.id,r.project_id,r.status,r.progress,r.output_key,r.output_size_bytes,r.error_code,r.error_message,r.attempts,r.created_at,r.updated_at,r.finished_at,p.name AS project_name FROM render_jobs r JOIN projects p ON p.id=r.project_id WHERE r.owner_id=? ORDER BY r.created_at DESC LIMIT 100")
        .bind(user.sub).all<RenderJobRow>();
      return json({ jobs: (result.results || []).map((job) => ({
        id: job.id, projectId: job.project_id, projectName: job.project_name, status: job.status, progress: job.progress,
        attempts: job.attempts, outputSizeBytes: job.output_size_bytes ?? null, errorCode: job.error_code, errorMessage: job.error_message,
        createdAt: job.created_at, updatedAt: job.updated_at, finishedAt: job.finished_at ?? null,
        downloadAvailable: job.status === "completed" && !!job.output_key,
      })) }, 200, headers);
    }
    const publicJobMatch = path.match(/^\/api\/v1\/render\/jobs\/([0-9a-f-]{36})(?:\/(download|cancel))?$/i);
    if (publicJobMatch) {
      const jobId = publicJobMatch[1];
      const action = publicJobMatch[2] || "";
      const job = await env.DB.prepare("SELECT id,owner_id,project_id,status,progress,output_key,output_size_bytes,error_code,error_message,attempts,created_at,updated_at,finished_at FROM render_jobs WHERE id=? AND owner_id=? LIMIT 1")
        .bind(jobId, user.sub).first<RenderJobRow>();
      if (!job) return fail("RENDER_JOB_NOT_FOUND", "Không tìm thấy render job hoặc bạn không có quyền.", requestId, 404, headers);
      if (action === "download" && method === "GET") {
        if (job.status !== "completed" || !job.output_key) return fail("RENDER_NOT_READY", "MP4 chưa sẵn sàng để tải.", requestId, 409, headers);
        if (!env.ASSETS) return fail("OBJECT_STORAGE_NOT_CONFIGURED", "R2 chưa được khai báo.", requestId, 503, headers);
        const object = await env.ASSETS.get(job.output_key);
        if (!object) return fail("RENDER_OUTPUT_MISSING", "File MP4 không còn trong R2.", requestId, 404, headers);
        const downloadHeaders = new Headers(headers);
        object.writeHttpMetadata(downloadHeaders);
        downloadHeaders.set("content-type", "video/mp4");
        downloadHeaders.set("content-disposition", "attachment; filename=\"hendy-render-" + jobId + ".mp4\"");
        downloadHeaders.set("cache-control", "private, no-store");
        if (object.httpEtag) downloadHeaders.set("etag", object.httpEtag);
        return new Response(object.body, { status: 200, headers: downloadHeaders });
      }
      if (action === "cancel" && method === "POST") {
        if (user.role === "viewer") return fail("ROLE_FORBIDDEN", "Tài khoản viewer không được hủy render.", requestId, 403, headers);
        if (job.status !== "queued") return fail("RENDER_ALREADY_STARTED", "Chỉ render job đang chờ mới có thể hủy bằng API hiện tại.", requestId, 409, headers);
        await env.DB.prepare("UPDATE render_jobs SET status='cancelled',updated_at=?,finished_at=? WHERE id=? AND owner_id=? AND status='queued'")
          .bind(new Date().toISOString(), new Date().toISOString(), jobId, user.sub).run();
        return json({ cancelled: true, id: jobId }, 200, headers);
      }
      if (method !== "GET" || action) return fail("METHOD_NOT_ALLOWED", "Method không được hỗ trợ cho render job.", requestId, 405, headers);
      return json({ job: {
        id: job.id, projectId: job.project_id, status: job.status, progress: job.progress, attempts: job.attempts,
        outputSizeBytes: job.output_size_bytes ?? null, errorCode: job.error_code, errorMessage: job.error_message,
        createdAt: job.created_at, updatedAt: job.updated_at, finishedAt: job.finished_at ?? null,
        downloadAvailable: job.status === "completed" && !!job.output_key,
      } }, 200, headers);
    }

    if (path === "/api/v1/projects" && method === "GET") {
      const result = await env.DB.prepare("SELECT id,name,status,manifest_json,created_at,updated_at FROM projects WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 200").bind(user.sub).all<ProjectRow>();
      const projects = (result.results || []).map((p) => ({ id: p.id, name: p.name, status: p.status, manifest: p.manifest_json ? JSON.parse(p.manifest_json) : null, createdAt: p.created_at, updatedAt: p.updated_at }));
      return json({ projects }, 200, headers);
    }
    if (path === "/api/v1/projects" && method === "POST") {
      const parsed = await readJson(request); if ("error" in parsed) return fail("INVALID_JSON", parsed.error, requestId, parsed.status, headers);
      const body = asRecord(parsed.value); const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 200) return fail("INVALID_PROJECT_NAME", "Tên dự án phải có từ 1 đến 200 ký tự.", requestId, 422, headers);
      const projectId = newId();
      await env.DB.prepare("INSERT INTO projects (id,owner_id,name,status,manifest_json) VALUES (?,?,?,'draft',NULL)").bind(projectId, user.sub, name).run();
      const project = await env.DB.prepare("SELECT id,name,status,created_at,updated_at FROM projects WHERE id = ? AND owner_id = ?").bind(projectId, user.sub).first<Record<string, unknown>>();
      return json({ project }, 201, headers);
    }
    const projectMatch = path.match(/^\/api\/v1\/projects\/([0-9a-f-]{36})$/i);
    if (projectMatch && ["GET", "PUT", "DELETE"].includes(method)) {
      const projectId = projectMatch[1];
      const exists = await env.DB.prepare("SELECT id,name,status,manifest_json,created_at,updated_at FROM projects WHERE id = ? AND owner_id = ? LIMIT 1").bind(projectId, user.sub).first<ProjectRow>();
      if (!exists) return fail("PROJECT_NOT_FOUND", "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", requestId, 404, headers);
      if (method === "GET") return json({ project: { id: exists.id, name: exists.name, status: exists.status, manifest: exists.manifest_json ? JSON.parse(exists.manifest_json) : null, createdAt: exists.created_at, updatedAt: exists.updated_at } }, 200, headers);
      if (method === "DELETE") { await env.DB.prepare("DELETE FROM projects WHERE id = ? AND owner_id = ?").bind(projectId, user.sub).run(); return json({ deleted: true, id: projectId }, 200, headers); }
      const parsed = await readJson(request); if ("error" in parsed) return fail("INVALID_JSON", parsed.error, requestId, parsed.status, headers);
      const body = asRecord(parsed.value); let name = exists.name; let manifestJson = exists.manifest_json;
      if (body && "name" in body) { if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 200) return fail("INVALID_PROJECT_NAME", "Tên dự án phải có từ 1 đến 200 ký tự.", requestId, 422, headers); name = body.name.trim(); }
      if (body && "manifest" in body) {
        if (body.manifest === null) manifestJson = null;
        else {
          const checked = validateManifest(body.manifest);
          if (!checked.valid) return fail("INVALID_MANIFEST", checked.reason, requestId, 422, headers);
          if (checked.manifest.projectId !== projectId) return fail("PROJECT_ID_MISMATCH", "manifest.projectId phải trùng ID dự án trên máy chủ.", requestId, 422, headers);
          const assetIds = [...new Set(checked.manifest.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)))];
          if (assetIds.length) {
            const placeholders = assetIds.map(() => "?").join(",");
            const rows = await env.DB.prepare("SELECT id FROM assets WHERE owner_id = ? AND id IN (" + placeholders + ")").bind(user.sub, ...assetIds).all<{ id: string }>();
            const owned = new Set((rows.results || []).map((row) => row.id));
            if (assetIds.some((assetId) => !owned.has(assetId))) return fail("ASSET_ACCESS_DENIED", "Manifest có tài nguyên chưa upload hoặc không thuộc tài khoản của bạn.", requestId, 422, headers);
          }
          manifestJson = JSON.stringify(checked.manifest);
        }
      }
      await env.DB.prepare("UPDATE projects SET name = ?, manifest_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND owner_id = ?").bind(name, manifestJson, projectId, user.sub).run();
      return json({ project: { id: projectId, name, status: exists.status, manifest: manifestJson ? JSON.parse(manifestJson) : null, updatedAt: new Date().toISOString() } }, 200, headers);
    }

    if (path === "/api/v1/assets" && method === "GET") {
      const result = await env.DB.prepare("SELECT id,name,mime_type,size_bytes,created_at FROM assets WHERE owner_id = ? ORDER BY created_at DESC LIMIT 500").bind(user.sub).all<AssetRow>();
      return json({ assets: result.results || [] }, 200, headers);
    }
    if (path === "/api/v1/assets" && method === "POST") {
      if (!env.ASSETS) return fail("OBJECT_STORAGE_NOT_CONFIGURED", "R2 chưa được khai báo. Chạy npm run bootstrap:production.", requestId, 503, headers);
      if (Number(request.headers.get("content-length") || "0") > MAX_UPLOAD_BYTES + 100_000) return fail("FILE_TOO_LARGE", "Giới hạn upload hiện tại là 20 MB mỗi file.", requestId, 413, headers);
      if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) return fail("UNSUPPORTED_UPLOAD", "Upload dùng multipart/form-data với trường file.", requestId, 415, headers);
      let form: FormData; try { form = await request.formData(); } catch { return fail("INVALID_UPLOAD", "Không đọc được multipart upload.", requestId, 400, headers); }
      const file = form.get("file"); if (!(file instanceof File) || file.size <= 0) return fail("INVALID_UPLOAD", "Thiếu file hoặc file rỗng.", requestId, 422, headers);
      if (file.size > MAX_UPLOAD_BYTES) return fail("FILE_TOO_LARGE", "Giới hạn upload hiện tại là 20 MB mỗi file.", requestId, 413, headers);
      const extension = file.name.split(".").pop()?.toLowerCase() || "";
      const inferredMime: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac", srt: "application/x-subrip", vtt: "text/vtt", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
      const mime = (file.type || inferredMime[extension] || "application/octet-stream").toLowerCase();
      if (!allowedMime(mime)) return fail("UNSUPPORTED_MEDIA_TYPE", "Định dạng được hỗ trợ: video, audio, phụ đề và ảnh phổ biến.", requestId, 415, headers);
      const assetId = newId(); const fileName = safeFileName(file.name); const objectKey = user.sub + "/" + assetId; const bytes = await file.arrayBuffer();
      try {
        await env.ASSETS.put(objectKey, bytes, { httpMetadata: { contentType: mime }, customMetadata: { ownerId: user.sub, assetId } });
        await env.DB.prepare("INSERT INTO assets (id,owner_id,name,mime_type,size_bytes,r2_key) VALUES (?,?,?,?,?,?)").bind(assetId, user.sub, fileName, mime, file.size, objectKey).run();
      } catch (error) {
        await env.ASSETS.delete(objectKey).catch(() => undefined);
        console.error(JSON.stringify({ event: "asset_upload_failed", requestId, ownerId: user.sub, assetId, error: error instanceof Error ? error.message : "unknown" }));
        return fail("ASSET_UPLOAD_FAILED", "Không thể lưu tài nguyên. Thử lại sau.", requestId, 500, headers);
      }
      return json({ asset: { id: assetId, name: fileName, mime_type: mime, size_bytes: file.size, created_at: new Date().toISOString() } }, 201, headers);
    }
    const assetMatch = path.match(/^\/api\/v1\/assets\/([0-9a-f-]{36})$/i);
    if (assetMatch && ["GET", "DELETE"].includes(method)) {
      const assetId = assetMatch[1]; const asset = await env.DB.prepare("SELECT id,owner_id,name,mime_type,size_bytes,r2_key,created_at FROM assets WHERE id = ? AND owner_id = ? LIMIT 1").bind(assetId, user.sub).first<AssetRow>();
      if (!asset) return fail("ASSET_NOT_FOUND", "Không tìm thấy tài nguyên hoặc bạn không có quyền truy cập.", requestId, 404, headers);
      if (method === "DELETE") { if (env.ASSETS) await env.ASSETS.delete(asset.r2_key); await env.DB.prepare("DELETE FROM assets WHERE id = ? AND owner_id = ?").bind(assetId, user.sub).run(); return json({ deleted: true, id: assetId }, 200, headers); }
      if (!env.ASSETS) return fail("OBJECT_STORAGE_NOT_CONFIGURED", "R2 chưa được khai báo.", requestId, 503, headers);
      const object = await env.ASSETS.get(asset.r2_key); if (!object) return fail("ASSET_OBJECT_MISSING", "Metadata tồn tại nhưng file trong R2 không tìm thấy.", requestId, 404, headers);
      const responseHeaders = new Headers(headers); object.writeHttpMetadata(responseHeaders); responseHeaders.set("content-type", asset.mime_type); responseHeaders.set("content-disposition", "inline; filename*=UTF-8''" + encodeURIComponent(asset.name)); responseHeaders.set("cache-control", "private, no-store"); if (object.httpEtag) responseHeaders.set("etag", object.httpEtag);
      return new Response(object.body, { status: 200, headers: responseHeaders });
    }
    return fail("NOT_FOUND", "Không tìm thấy API endpoint.", requestId, 404, headers);
  }
  if (path.startsWith("/api/")) return fail("NOT_FOUND", "Không tìm thấy API endpoint.", requestId, 404, headers);
  return json({ service: env.APP_NAME || "Hendy Suite API", docs: "/api/v1/meta", health: "/healthz" }, 200, headers);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get("x-request-id")?.slice(0, 128) || newId();
    const headers = { ...corsHeaders(request, env), "x-request-id": requestId };
    const origin = request.headers.get("origin") || "";
    if (request.method === "OPTIONS") return origin && !originAllowed(origin, env) ? new Response(null, { status: 403, headers: { vary: "Origin" } }) : new Response(null, { status: 204, headers });
    if (origin && !originAllowed(origin, env)) return fail("ORIGIN_NOT_ALLOWED", "Origin không nằm trong CORS allowlist.", requestId, 403, { "x-request-id": requestId, vary: "Origin" });
    try { return await route(request, env, requestId, headers); }
    catch (error) {
      console.error(JSON.stringify({ event: "unhandled_api_error", requestId, message: error instanceof Error ? error.message : "unknown" }));
      return fail("INTERNAL_ERROR", "Máy chủ gặp lỗi không mong đợi.", requestId, 500, headers);
    }
  },
};
