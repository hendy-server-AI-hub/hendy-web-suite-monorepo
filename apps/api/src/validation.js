export const MAX_JSON_BYTES = 1048576;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 80 * 1024 * 1024;
export const MAX_CLIPS = 120;
export const MAX_DURATION = 1800;

export const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function validateManifest(input) {
  if (!isRecord(input) || input.version !== 1) return { valid: false, reason: "Manifest version 1 is required." };
  if (!validUuid(input.projectId)) return { valid: false, reason: "projectId must be a UUID." };
  const out = input.output;
  if (!isRecord(out) || !Number.isInteger(out.width) || out.width < 320 || out.width > 3840 ||
      !Number.isInteger(out.height) || out.height < 240 || out.height > 2160 ||
      !Number.isInteger(out.fps) || out.fps < 1 || out.fps > 60 || out.format !== "mp4") {
    return { valid: false, reason: "Output must be MP4, 320x240-3840x2160 and 1-60 FPS." };
  }
  if (!Array.isArray(input.tracks) || input.tracks.length < 1 || input.tracks.length > 16) {
    return { valid: false, reason: "Manifest must contain 1-16 tracks." };
  }
  const trackIds = new Set(); const clipIds = new Set();
  let count = 0; let duration = 0;
  for (const track of input.tracks) {
    if (!isRecord(track) || typeof track.id !== "string" || !track.id ||
        !["video", "audio"].includes(track.kind) || !Array.isArray(track.clips)) return { valid: false, reason: "Invalid track structure." };
    if (trackIds.has(track.id)) return { valid: false, reason: "Track IDs must be unique." };
    trackIds.add(track.id);
    for (const clip of track.clips) {
      if (++count > MAX_CLIPS) return { valid: false, reason: "Maximum 120 clips per manifest." };
      if (!isRecord(clip) || typeof clip.id !== "string" || !clip.id || clipIds.has(clip.id) ||
          !validUuid(clip.assetId) || typeof clip.start !== "number" || !Number.isFinite(clip.start) || clip.start < 0 ||
          typeof clip.duration !== "number" || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > MAX_DURATION ||
          (clip.inPoint !== undefined && (typeof clip.inPoint !== "number" || !Number.isFinite(clip.inPoint) || clip.inPoint < 0))) {
        return { valid: false, reason: "Invalid clip ID, asset, start, duration or inPoint." };
      }
      clipIds.add(clip.id);
      duration = Math.max(duration, clip.start + clip.duration);
    }
  }
  if (count === 0) return { valid: false, reason: "Manifest must contain at least one clip." };
  if (duration > MAX_DURATION) return { valid: false, reason: "Timeline is limited to 30 minutes." };
  return { valid: true, manifest: input, clipCount: count, trackCount: input.tracks.length, duration };
}
export function allowedMediaType(mime) {
  return /^(video\/(mp4|webm|quicktime|x-matroska)|audio\/(mpeg|mp4|wav|x-wav|ogg|webm|flac|aac)|image\/(jpeg|png|webp))$/i.test(String(mime || ""));
}
export function safeFilename(value) {
  const name = String(value || "upload").replace(/\\/g, "/").split("/").pop() || "upload";
  return name.replace(/[^\w.\- ()\u00A0-\u024F]/g, "_").slice(0, 180) || "upload";
}
export function parseOrigins(value) { return String(value || "").split(",").map((item) => item.trim()).filter(Boolean); }
