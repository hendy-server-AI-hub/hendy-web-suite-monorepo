import type { ApiError, ApiMeta, ProjectSummary } from "@hendy/shared-types";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");
const TOKEN_KEY = "hendy-api-token";

export interface CurrentUser { id: string; email: string; role: string; }
export interface AssetSummary { id: string; name: string; mime_type: string; size_bytes: number; created_at: string; }
export interface ApiHealth {
  status: string;
  version: string;
  capabilities: { databaseConfigured: boolean; objectStorageConfigured: boolean; authenticationConfigured: boolean };
}
export function getStoredToken(): string {
  try { return window.localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function clearStoredToken(): void {
  try { window.localStorage.removeItem(TOKEN_KEY); } catch { /* storage disabled */ }
}
async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE_URL) throw new Error("Chưa cấu hình VITE_API_BASE_URL.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
    const token = getStoredToken();
    if (token) headers.set("authorization", "Bearer " + token);
    const response = await fetch(API_BASE_URL + path, { ...init, headers, signal: controller.signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const data = payload as Partial<ApiError> | null;
      throw new Error(data?.error?.message || "API HTTP " + response.status);
    }
    if (!payload || typeof payload !== "object") throw new Error("API response không hợp lệ.");
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("API hết thời gian phản hồi.");
    if (error instanceof TypeError) throw new Error("Không kết nối được API; kiểm tra URL và CORS.");
    throw error instanceof Error ? error : new Error("API request thất bại.");
  } finally {
    window.clearTimeout(timeout);
  }
}
export function getApiMeta(): Promise<ApiMeta> { return requestJson("/api/v1/meta"); }
export function getHealth(): Promise<ApiHealth> { return requestJson("/healthz"); }
export async function login(email: string, password: string): Promise<{ token: string; user: CurrentUser; expiresAt: string }> {
  const session = await requestJson<{ token: string; user: CurrentUser; expiresAt: string }>("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  window.localStorage.setItem(TOKEN_KEY, session.token);
  return session;
}
export function getCurrentUser(): Promise<{ user: CurrentUser; expiresAt: string }> { return requestJson("/api/v1/auth/me"); }
export function listProjects(): Promise<{ projects: Array<ProjectSummary & { createdAt?: string; manifest?: unknown }> }> { return requestJson("/api/v1/projects"); }
export function listAssets(): Promise<{ assets: AssetSummary[] }> { return requestJson("/api/v1/assets"); }
