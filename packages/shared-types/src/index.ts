export type AppRole = "owner" | "admin" | "editor" | "viewer";
export type ProjectStatus = "draft" | "processing" | "completed" | "failed";

export interface ApiError {
  error: { code: string; message: string; requestId: string };
}

export interface ApiMeta {
  name: string;
  version: string;
  environment: string;
  features: string[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: ProjectStatus;
  updatedAt: string;
  durationSeconds?: number;
}

export interface RenderManifest {
  version: 1;
  projectId: string;
  output: { width: number; height: number; fps: number; format: "mp4" };
  tracks: Array<{
    id: string;
    kind: "video" | "audio" | "subtitle";
    clips: Array<{ id: string; assetId: string; start: number; duration: number }>;
  }>;
}
