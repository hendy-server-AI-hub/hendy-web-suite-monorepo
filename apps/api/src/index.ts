import type { ApiError, ApiMeta, RenderManifest } from "@hendy/shared-types";

interface Env {
  APP_NAME?: string;
  APP_VERSION?: string;
  APP_ENV?: string;
  CORS_ORIGIN?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" };

function requestId(): string { return crypto.randomUUID(); }
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const incoming = request.headers.get("origin") || "";
  const configured = (env.CORS_ORIGIN || "*").split(",").map((v) => v.trim()).filter(Boolean);
  const allowed = configured.includes("*") ? "*" : (configured.includes(incoming) ? incoming : "null");
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-request-id",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function fail(code: string, message: string, id: string, status: number, headers: Record<string, string>): Response {
  const body: ApiError = { error: { code, message, requestId: id } };
  return json(body, status, headers);
}
function validateManifest(input: unknown): { valid: true; manifest: RenderManifest } | { valid: false; reason: string } {
  if (!input || typeof input !== "object") return { valid: false, reason: "Body phải là JSON object." };
  const data = input as Record<string, unknown>;
  if (data.version !== 1) return { valid: false, reason: "manifest.version phải bằng 1." };
  if (typeof data.projectId !== "string" || data.projectId.trim().length < 1 || data.projectId.length > 128) return { valid: false, reason: "projectId không hợp lệ." };
  const output = data.output as Record<string, unknown> | undefined;
  if (!output || typeof output.width !== "number" || !Number.isInteger(output.width) || typeof output.height !== "number" || !Number.isInteger(output.height) || typeof output.fps !== "number" || !Number.isFinite(output.fps) || output.format !== "mp4") return { valid: false, reason: "output cần width, height, fps và format=mp4 hợp lệ." };
  if ((output.width as number) < 160 || (output.width as number) > 7680 || (output.height as number) < 160 || (output.height as number) > 4320 || (output.fps as number) < 1 || (output.fps as number) > 120) return { valid: false, reason: "Thông số xuất video nằm ngoài giới hạn cho phép." };
  if (!Array.isArray(data.tracks) || data.tracks.length > 64) return { valid: false, reason: "tracks phải là mảng tối đa 64 track." };
  const normalized = data.tracks as RenderManifest["tracks"];
  for (const track of normalized) {
    if (!track || typeof track.id !== "string" || !["video", "audio", "subtitle"].includes(track.kind) || !Array.isArray(track.clips)) return { valid: false, reason: "Cấu trúc track không hợp lệ." };
    if (track.clips.length > 5000) return { valid: false, reason: "Mỗi track không được vượt quá 5000 clip." };
    for (const clip of track.clips) {
      if (!clip || typeof clip.id !== "string" || typeof clip.assetId !== "string" || !Number.isFinite(clip.start) || !Number.isFinite(clip.duration) || clip.start < 0 || clip.duration <= 0) return { valid: false, reason: "Clip chứa ID, thời điểm hoặc thời lượng không hợp lệ." };
    }
  }
  return { valid: true, manifest: data as unknown as RenderManifest };
}

async function route(request: Request, env: Env, id: string, headers: Record<string, string>): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "GET" && (path === "/healthz" || path === "/api/v1/health")) {
    return json({ status: "ok", service: env.APP_NAME || "Hendy Suite API", version: env.APP_VERSION || "1.0.0", timestamp: new Date().toISOString(), requestId: id }, 200, { ...headers, "cache-control": "no-cache" });
  }
  if (request.method === "GET" && path === "/api/v1/meta") {
    const data: ApiMeta = { name: env.APP_NAME || "Hendy Suite API", version: env.APP_VERSION || "1.0.0", environment: env.APP_ENV || "development", features: ["health-check", "manifest-validation", "request-tracing"] };
    return json(data, 200, headers);
  }
  if (request.method === "POST" && path === "/api/v1/render/validate") {
    let payload: unknown;
    try { payload = await request.json(); }
    catch { return fail("INVALID_JSON", "Request body phải là JSON hợp lệ.", id, 400, headers); }
    const result = validateManifest(payload);
    if (!result.valid) return fail("INVALID_MANIFEST", result.reason, id, 422, headers);
    return json({ valid: true, projectId: result.manifest.projectId, trackCount: result.manifest.tracks.length, clipCount: result.manifest.tracks.reduce((sum, track) => sum + track.clips.length, 0), note: "Manifest đã hợp lệ về cấu trúc; chưa tạo tác vụ render." }, 200, headers);
  }
  if (path.startsWith("/api/")) return fail("NOT_FOUND", "Không tìm thấy API endpoint.", id, 404, headers);
  return json({ service: env.APP_NAME || "Hendy Suite API", docs: "/api/v1/meta", health: "/healthz" }, 200, headers);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = request.headers.get("x-request-id")?.slice(0, 128) || requestId();
    const headers = { ...corsHeaders(request, env), "x-request-id": id };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      const response = await route(request, env, id, headers);
      return response;
    } catch (error) {
      console.error(JSON.stringify({ event: "unhandled_api_error", requestId: id, message: error instanceof Error ? error.message : "unknown" }));
      return fail("INTERNAL_ERROR", "Máy chủ gặp lỗi không mong đợi.", id, 500, headers);
    }
  },
};
