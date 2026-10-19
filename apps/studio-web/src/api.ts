import type { ApiError, ApiMeta, RenderManifest } from "@hendy/shared-types";

const configuredBase = (import.meta.env.VITE_API_BASE_URL || "").trim();
export const API_BASE_URL = configuredBase.replace(/\/+$/, "");
export const isApiConfigured = API_BASE_URL.length > 0;

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
