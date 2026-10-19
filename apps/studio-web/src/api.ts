import type { ApiError, ApiMeta, RenderManifest } from "@hendy/shared-types";

const configuredBase = (import.meta.env.VITE_API_BASE_URL || "").trim();
export const API_BASE_URL = configuredBase.replace(/\/+$/, "");
export const isApiConfigured = API_BASE_URL.length > 0;
export const AUTH_TOKEN_STORAGE_KEY = "hendy-api-token";

export interface AuthSession {
  token: string;
  tokenType: "Bearer";
  expiresAt: string;
  user: { id: string; email: string; role: string };
}
export interface CloudProject {
  id: string;
  name: string;
  status: "draft" | "processing" | "completed" | "failed";
  manifest?: RenderManifest | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface CloudAsset {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}
export function getAccessToken(): string {
  try { return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || ""; } catch { return ""; }
}
export function clearAccessToken(): void {
  try { window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY); } catch { /* storage may be disabled */ }
}


export interface ManifestValidationResult {
  valid: true;
  projectId: string;
  trackCount: number;
  clipCount: number;
  note: string;
}

function makeRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  const requestId = makeRequestId();

  try {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("x-request-id", requestId);
    const token = getAccessToken();
    if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    if (init.body != null && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers,
    });

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const apiError = payload as Partial<ApiError> | null;
      const message = apiError?.error?.message || `API trả về HTTP ${response.status}.`;
      const serverRequestId = apiError?.error?.requestId || response.headers.get("x-request-id") || requestId;
      throw new Error(`${message} (request ID: ${serverRequestId})`);
    }
    if (payload === null || typeof payload !== "object") {
      throw new Error("API trả về dữ liệu không phải JSON object hợp lệ.");
    }
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("API hết thời gian phản hồi sau 10 giây.");
    }
    if (error instanceof TypeError) {
      throw new Error("Không kết nối được API. Hãy kiểm tra VITE_API_BASE_URL, CORS và trạng thái Worker.");
    }
    throw error instanceof Error ? error : new Error("Lỗi không xác định khi gọi API.");
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getApiMeta(): Promise<ApiMeta> {
  return requestJson<ApiMeta>("/api/v1/meta", { method: "GET" });
}

export function validateRenderManifest(manifest: RenderManifest): Promise<ManifestValidationResult> {
  return requestJson<ManifestValidationResult>("/api/v1/render/validate", {
    method: "POST",
    body: JSON.stringify(manifest),
  });
}


export async function login(email: string, password: string): Promise<AuthSession> {
  const session = await requestJson<AuthSession>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, session.token);
  return session;
}

export async function getCurrentUser(): Promise<{ user: AuthSession["user"]; expiresAt: string }> {
  return requestJson("/api/v1/auth/me");
}

export async function listProjects(): Promise<{ projects: CloudProject[] }> {
  return requestJson("/api/v1/projects");
}

export async function createProject(name: string): Promise<{ project: CloudProject }> {
  return requestJson("/api/v1/projects", { method: "POST", body: JSON.stringify({ name }) });
}

export async function saveProject(projectId: string, patch: { name?: string; manifest?: RenderManifest | null }): Promise<{ project: CloudProject }> {
  return requestJson("/api/v1/projects/" + encodeURIComponent(projectId), { method: "PUT", body: JSON.stringify(patch) });
}

export async function deleteProject(projectId: string): Promise<{ deleted: boolean; id: string }> {
  return requestJson("/api/v1/projects/" + encodeURIComponent(projectId), { method: "DELETE" });
}

export async function listAssets(): Promise<{ assets: CloudAsset[] }> {
  return requestJson("/api/v1/assets");
}

export async function uploadAsset(file: File): Promise<{ asset: CloudAsset }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);
  const requestId = makeRequestId();
  const headers = new Headers({ accept: "application/json", "x-request-id": requestId });
  const token = getAccessToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const form = new FormData();
  form.append("file", file, file.name);
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/assets`, { method: "POST", headers, body: form, signal: controller.signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const apiError = payload as Partial<ApiError> | null;
      throw new Error(apiError?.error?.message || `Upload thất bại (HTTP ${response.status}).`);
    }
    return payload as { asset: CloudAsset };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Upload quá thời gian chờ.");
    if (error instanceof TypeError) throw new Error("Không kết nối được API khi upload. Kiểm tra CORS và trạng thái Worker.");
    throw error instanceof Error ? error : new Error("Upload tài nguyên thất bại.");
  } finally {
    window.clearTimeout(timeout);
  }
}

export function assetDownloadUrl(assetId: string): string {
  return API_BASE_URL + "/api/v1/assets/" + encodeURIComponent(assetId);
}


export interface RenderJob {
  id: string;
  projectId: string;
  projectName?: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled" | string;
  progress: number;
  attempts: number;
  outputSizeBytes?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  downloadAvailable: boolean;
}

export function createRenderJob(projectId: string): Promise<{ job: RenderJob; message: string }> {
  return requestJson("/api/v1/render/jobs", { method: "POST", body: JSON.stringify({ projectId }) });
}
export function getRenderJob(jobId: string): Promise<{ job: RenderJob }> {
  return requestJson("/api/v1/render/jobs/" + encodeURIComponent(jobId));
}
export function listRenderJobs(): Promise<{ jobs: RenderJob[] }> {
  return requestJson("/api/v1/render/jobs");
}
export async function downloadRenderOutput(jobId: string): Promise<Blob> {
  if (!API_BASE_URL) throw new Error("Chưa cấu hình VITE_API_BASE_URL.");
  const token = getAccessToken();
  if (!token) throw new Error("Đăng nhập trước khi tải MP4.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(API_BASE_URL + "/api/v1/render/jobs/" + encodeURIComponent(jobId) + "/download", {
      headers: { authorization: "Bearer " + token, accept: "video/mp4, application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const apiError = payload as Partial<ApiError> | null;
      throw new Error(apiError?.error?.message || "Không tải được MP4 (HTTP " + response.status + ").");
    }
    return await response.blob();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Tải MP4 quá thời gian chờ.");
    if (error instanceof TypeError) throw new Error("Không kết nối được API khi tải MP4.");
    throw error instanceof Error ? error : new Error("Tải MP4 thất bại.");
  } finally {
    window.clearTimeout(timeout);
  }
}
