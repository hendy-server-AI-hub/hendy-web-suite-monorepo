export const MAX_JSON_BYTES = 1048576;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_RENDER_OUTPUT_BYTES = 80 * 1024 * 1024;
export const MAX_RENDER_CLIPS = 120;
export const MAX_RENDER_DURATION_SECONDS = 1800;

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateManifest(input) {
  if (!isRecord(input)) return { valid: false, reason: "Manifest must be an object." };
  if (input.version !== 1) return { valid: false, reason: "Manifest version must equal 1." };
  if (typeof input.projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.projectId)) {
    return { valid: false, reason: "projectId must be a UUID." };
  }
  if (!isRecord(input.output)) return { valid: false, reason: "output is required." };
  const output = input.output;
  if (!Number.isInteger(output.width) || output.width < 320 || output.width > 3840 ||
      !Number.isInteger(output.height) || output.height < 240 || output.height > 2160 ||
      !Number.isInteger(output.fps) || output.fps < 1 || output.fps > 60 ||
      output.format !== "mp4") {
    return { valid: false, reason: "Output must be MP4 between 320x240 and 3840x2160 at 1-60 FPS." };
  }
  if (!Array.isArray(input.tracks) || input.tracks.length < 1 || input.tracks.length > 16) {
    return { valid: false, reason: "tracks must contain 1-16 tracks." };
  }
  const trackIds = new Set();
  const clipIds = new Set();
  let clipCount = 0;
  let maxEnd = 0;
  for (const track of input.tracks) {
    if (!isRecord(track) || typeof track.id !== "string" || !track.id ||
        !["video", "audio"].includes(track.kind) || !Array.isArray(track.clips)) {
      return { valid: false, reason: "Each track needs an ID, video/audio kind and clips array." };
    }
    if (trackIds.has(track.id)) return { valid: false, reason: "Track IDs must be unique." };
    trackIds.add(track.id);
    for (const clip of track.clips) {
      clipCount++;
      if (clipCount > MAX_RENDER_CLIPS) return { valid: false, reason: "Maximum 120 clips per manifest." };
      if (!isRecord(clip) || typeof clip.id !== "string" || !clip.id ||
          typeof clip.assetId !== "string" || !/^[0-9a-f-]{36}$/i.test(clip.assetId) ||
          typeof clip.start !== "number" || !Number.isFinite(clip.start) || clip.start < 0 ||
          typeof clip.duration !== "number" || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > MAX_RENDER_DURATION_SECONDS ||
          (clip.inPoint !== undefined && (typeof clip.inPoint !== "number" || !Number.isFinite(clip.inPoint) || clip.inPoint < 0))) {
        return { valid: false, reason: "Clip ID, assetId, start, duration or inPoint is invalid." };
      }
      if (clipIds.has(clip.id)) return { valid: false, reason: "Clip IDs must be unique across the manifest." };
      clipIds.add(clip.id);
      maxEnd = Math.max(maxEnd, clip.start + clip.duration);
    }
  }
  if (clipCount < 1) return { valid: false, reason: "Manifest must contain at least one clip." };
  if (maxEnd > MAX_RENDER_DURATION_SECONDS) return { valid: false, reason: "Timeline duration is limited to 30 minutes." };
  return { valid: true, manifest: input, clipCount, trackCount: input.tracks.length, duration: maxEnd };
}

export function allowedMediaType(mime) {
  return /^(video\/(mp4|webm|quicktime|x-matroska)|audio\/(mpeg|mp4|wav|x-wav|ogg|webm|flac|aac)|image\/(jpeg|png|webp))$/i.test(String(mime || ""));
}

export function safeFilename(input) {
  const basename = String(input || "upload").replace(/\\/g, "/").split("/").pop() || "upload";
  return basename.replace(/[^\w.\- ()\u00A0-\u024F]/g, "_").slice(0, 180) || "upload";
}

export function parseOrigins(value) {
  return String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
}
