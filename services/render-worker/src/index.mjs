import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const API_URL = (process.env.HENDY_API_URL || "").trim().replace(/\/+$/, "");
const SERVICE_TOKEN = process.env.RENDER_SERVICE_TOKEN || "";
const WORKER_ID = (process.env.RENDER_WORKER_ID || "render-" + randomUUID()).slice(0, 80);
const POLL_INTERVAL_MS = positiveInt(process.env.POLL_INTERVAL_MS, 2000, 250, 60_000);
const JOB_TIMEOUT_MS = positiveInt(process.env.JOB_TIMEOUT_MS, 45 * 60_000, 60_000, 2 * 60 * 60_000);
const MAX_INPUT_BYTES = positiveInt(process.env.MAX_INPUT_BYTES, 250 * 1024 * 1024, 20 * 1024 * 1024, 1024 * 1024 * 1024);
const MAX_OUTPUT_BYTES = positiveInt(process.env.MAX_OUTPUT_BYTES, 80 * 1024 * 1024, 10 * 1024 * 1024, 80 * 1024 * 1024);
const HEALTH_PORT = positiveInt(process.env.HEALTH_PORT, 8787, 1024, 65_535);
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const MAX_CLIPS = 120;
const MAX_DURATION_SECONDS = 1800;
const MAX_RESOLUTION_WIDTH = 3840;
const MAX_RESOLUTION_HEIGHT = 2160;
const MAX_FPS = 60;

let stopping = false;
let activeJobId = "";
let activeProgress = 0;
let lastError = "";

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function sleep(ms) { return delay(ms); }
function log(event, extra = {}) {
  // Avoid logging tokens, raw manifests, credentials, or request bodies.
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, workerId: WORKER_ID, ...extra }));
}
function mimeExtension(contentType, remoteName = "") {
  const known = {
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/x-matroska": ".mkv",
    "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/x-wav": ".wav",
    "audio/ogg": ".ogg", "audio/flac": ".flac", "audio/aac": ".aac",
    "application/x-subrip": ".srt", "text/plain": extname(remoteName).toLowerCase() === ".srt" ? ".srt" : ".txt",
    "text/vtt": ".vtt", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  };
  return known[(contentType || "").split(";")[0].trim().toLowerCase()] || extname(remoteName).toLowerCase() || ".bin";
}
function parseFilename(response) {
  const raw = response.headers.get("x-asset-name");
  if (!raw) return "";
  try { return decodeURIComponent(raw); } catch { return ""; }
}
function safeNumber(value, label, min = 0, max = 1800) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error("Invalid " + label + " value in render manifest");
  }
  return value;
}
async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
  try {
    const headers = new Headers(options.headers || {});
    headers.set("authorization", "Bearer " + SERVICE_TOKEN);
    headers.set("x-render-worker-id", WORKER_ID);
    if (options.json !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(API_URL + path, {
      method: options.method || "GET",
      headers,
      body: options.json === undefined ? options.body : JSON.stringify(options.json),
      signal: controller.signal,
      ...(options.duplex ? { duplex: options.duplex } : {}),
    });
    if (options.expectStream) {
      if (!response.ok) throw new Error("API returned HTTP " + response.status + " for " + path);
      return response;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message || "API returned HTTP " + response.status;
      throw new Error(message);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("API request timed out");
    throw error instanceof Error ? error : new Error("API request failed");
  } finally {
    clearTimeout(timeout);
  }
}
async function fetchAsset(assetId, jobId, folder) {
  const response = await apiRequest(
    "/internal/render/assets/" + encodeURIComponent(assetId) + "?jobId=" + encodeURIComponent(jobId),
    { expectStream: true, timeoutMs: 60_000 },
  );
  const name = parseFilename(response);
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const extension = mimeExtension(contentType, name);
  const path = join(folder, "asset-" + randomUUID() + extension);
  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength) throw new Error("Downloaded empty asset " + assetId);
  return { assetId, name, contentType: contentType.split(";")[0].trim().toLowerCase(), path, bytes: Buffer.from(arrayBuffer) };
}
function msToSrtTime(milliseconds) {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const ms = value % 1000;
  return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "," + String(ms).padStart(3, "0");
}
function parseSubtitleTime(value) {
  const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1000 + Number(match[4]);
}
function mergeSubtitleCues(subtitleClips, downloaded) {
  const output = [];
  let sequence = 1;
  for (const clip of subtitleClips) {
    const item = downloaded.get(clip.assetId);
    if (!item) throw new Error("Subtitle asset could not be loaded");
    const text = item.bytes.toString("utf8").replace(/^\uFEFF/, "");
    const blocks = text.split(/\r?\n\s*\r?\n/);
    const startOffset = Math.round(clip.start * 1000);
    const allowedDuration = Math.round(clip.duration * 1000);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeIndex < 0) continue; // ignores WEBVTT header and metadata blocks
      const matches = [...lines[timeIndex].matchAll(/(\d{1,3}:\d{2}:\d{2}[,.]\d{3})/g)];
      if (matches.length < 2) continue;
      const localStart = parseSubtitleTime(matches[0][1]);
      const localEnd = parseSubtitleTime(matches[1][1]);
      if (localStart === null || localEnd === null || localEnd <= localStart || localStart >= allowedDuration) continue;
      const globalStart = startOffset + localStart;
      const globalEnd = startOffset + Math.min(localEnd, allowedDuration);
      const cueText = lines.slice(timeIndex + 1).join("\n").trim();
      if (!cueText || globalEnd <= globalStart) continue;
      output.push(String(sequence++));
      output.push(msToSrtTime(globalStart) + " --> " + msToSrtTime(globalEnd));
      output.push(cueText);
      output.push("");
    }
  }
  return output.join("\n");
}
function numberString(value, label) {
  const n = safeNumber(value, label);
  return Number(n.toFixed(3)).toString();
}
function buildFfmpegArgs(manifest, inputRecords, subtitlePath, outputPath, duration) {
  const width = manifest.output.width;
  const height = manifest.output.height;
  const fps = manifest.output.fps;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 160 || height < 160 || width > MAX_RESOLUTION_WIDTH || height > MAX_RESOLUTION_HEIGHT) throw new Error("Render resolution must be between 160px and 4K");
  if (!Number.isFinite(fps) || fps < 1 || fps > MAX_FPS) throw new Error("Render FPS must be between 1 and 60");
  const args = ["-hide_banner", "-y", "-loglevel", "warning", "-progress", "pipe:1", "-nostats"];
  const inputIndex = new Map();
  let nextIndex = 0;
  for (const record of inputRecords) {
    inputIndex.set(record.key, nextIndex++);
    if (record.kind === "image") args.push("-loop", "1", "-framerate", String(fps), "-t", numberString(record.duration, "image duration"), "-i", record.path);
    else args.push("-i", record.path);
  }

  const filters = [];
  filters.push("color=c=black:s=" + width + "x" + height + ":r=" + fps + ":d=" + numberString(duration, "duration") + "[base0]");
  let currentBase = "base0";
  const videoRecords = inputRecords.filter((record) => record.trackKind === "video");
  videoRecords.forEach((record, position) => {
    const idx = inputIndex.get(record.key);
    const start = safeNumber(record.start, "video start");
    const clipDuration = safeNumber(record.duration, "video duration", 0.05, duration);
    const end = Math.min(duration, start + clipDuration);
    const clipLabel = "vclip" + position;
    const nextBase = "base" + (position + 1);
    filters.push("[" + idx + ":v:0]trim=duration=" + numberString(clipDuration, "video duration") +
      ",setpts=PTS-STARTPTS+" + numberString(start, "video start") + "/TB" +
      ",scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease" +
      ",pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,setsar=1,fps=" + fps + ",format=yuv420p[" + clipLabel + "]");
    filters.push("[" + currentBase + "][" + clipLabel + "]overlay=0:0:eof_action=pass:shortest=0:enable='between(t," +
      numberString(start, "video start") + "," + numberString(end, "video end") + ")'[" + nextBase + "]");
    currentBase = nextBase;
  });

  if (subtitlePath) {
    // Generated path contains only system-temp characters; no user filename enters filter syntax.
    const subtitleLabel = "vout";
    filters.push("[" + currentBase + "]subtitles=filename=" + subtitlePath + ":force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=0'[" + subtitleLabel + "]");
    currentBase = subtitleLabel;
  }

  const audioRecords = inputRecords.filter((record) => record.trackKind === "audio");
  const outputMaps = ["-map", "[" + currentBase + "]"];
  if (audioRecords.length) {
    const audioLabels = [];
    audioRecords.forEach((record, position) => {
      const idx = inputIndex.get(record.key);
      const start = safeNumber(record.start, "audio start");
      const clipDuration = safeNumber(record.duration, "audio duration", 0.05, duration);
      const delayMs = Math.max(0, Math.round(start * 1000));
      const label = "aclip" + position;
      filters.push("[" + idx + ":a:0]atrim=duration=" + numberString(clipDuration, "audio duration") +
        ",asetpts=PTS-STARTPTS,volume=1,adelay=" + delayMs + "|" + delayMs + "[" + label + "]");
      audioLabels.push("[" + label + "]");
    });
    filters.push(audioLabels.join("") + "amix=inputs=" + audioLabels.length + ":duration=longest:normalize=0,atrim=duration=" +
      numberString(duration, "duration") + ",asetpts=PTS-STARTPTS[aout]");
    outputMaps.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  } else {
    outputMaps.push("-an");
  }

  args.push("-filter_complex", filters.join(";"), ...outputMaps);
  args.push("-t", numberString(duration, "duration"), "-r", String(fps), "-c:v", "libx264", "-preset", process.env.FFMPEG_PRESET || "veryfast",
    "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-metadata", "title=Hendy Studio Render", outputPath);
  return args;
}
async function runFfmpeg(args, onProgress, duration) {
  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutBuffer = "";
    let lastProgressAt = 0;
    let failed = false;
    const timeout = setTimeout(() => {
      failed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, JOB_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("out_time_ms=")) continue;
        const us = Number(line.slice("out_time_ms=".length));
        if (!Number.isFinite(us) || duration <= 0) continue;
        const percent = Math.min(99, Math.max(1, Math.floor((us / 1_000_000 / duration) * 100)));
        const now = Date.now();
        if (now - lastProgressAt > 5000) {
          lastProgressAt = now;
          Promise.resolve(onProgress(percent)).catch(() => undefined);
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (failed) reject(new Error("FFmpeg job timed out."));
      else if (code !== 0) reject(new Error("FFmpeg exited with code " + code + ": " + stderr.trim().slice(-1800)));
      else resolve();
    });
  });
}
async function renderJob(job) {
  const manifest = job.manifest;
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.tracks)) throw new Error("Job manifest is missing or invalid");
  const allClips = manifest.tracks.flatMap((track) => track.clips.map((clip) => ({ ...clip, trackKind: track.kind })));
  if (allClips.length < 1 || allClips.length > MAX_CLIPS) throw new Error("Render job clip count exceeds the worker limit");
  const duration = Math.max(...allClips.map((clip) => safeNumber(clip.start, "clip start") + safeNumber(clip.duration, "clip duration", 0.05, MAX_DURATION_SECONDS)));
  if (duration <= 0 || duration > MAX_DURATION_SECONDS) throw new Error("Render job duration exceeds 30 minutes");
  const folder = await mkdtemp(join(tmpdir(), "hendy-render-"));
  try {
    const uniqueAssetIds = [...new Set(allClips.map((clip) => {
      if (typeof clip.assetId !== "string" || !clip.assetId) throw new Error("Manifest clip is missing an assetId");
      return clip.assetId;
    }))];
    const downloaded = new Map();
    let totalInputBytes = 0;
    for (const assetId of uniqueAssetIds) {
      const asset = await fetchAsset(assetId, job.id, folder);
      totalInputBytes += asset.bytes.byteLength;
      if (totalInputBytes > MAX_INPUT_BYTES) throw new Error("Total source media exceeds the configured worker input limit");
      await writeFile(asset.path, asset.bytes, { mode: 0o600 });
      downloaded.set(assetId, asset);
      await updateProgress(job.id, 2 + Math.floor(downloaded.size / uniqueAssetIds.length * 8));
    }

    const subtitleClips = allClips.filter((clip) => clip.trackKind === "subtitle");
    let subtitlePath = "";
    if (subtitleClips.length) {
      const srt = mergeSubtitleCues(subtitleClips, downloaded);
      if (srt.trim()) {
        subtitlePath = join(folder, "subtitles.srt");
        await writeFile(subtitlePath, srt, { mode: 0o600 });
      }
    }

    const inputRecords = [];
    for (let position = 0; position < allClips.length; position++) {
      const clip = allClips[position];
      if (clip.trackKind === "subtitle") continue;
      if (clip.trackKind !== "video" && clip.trackKind !== "audio") continue;
      const asset = downloaded.get(clip.assetId);
      if (!asset) throw new Error("Missing downloaded media source");
      const image = asset.contentType.startsWith("image/");
      if (clip.trackKind === "video" && !image && !asset.contentType.startsWith("video/")) throw new Error("Video track contains a non-video source.");
      if (clip.trackKind === "audio" && !asset.contentType.startsWith("audio/") && !asset.contentType.startsWith("video/")) throw new Error("Audio track contains an unsupported source.");
      inputRecords.push({
        key: "input-" + position,
        path: asset.path,
        kind: image ? "image" : "media",
        trackKind: clip.trackKind,
        start: clip.start,
        duration: clip.duration,
      });
    }
    const outputPath = join(folder, "output.mp4");
    const args = buildFfmpegArgs(manifest, inputRecords, subtitlePath, outputPath, duration);
    await updateProgress(job.id, 12);
    await runFfmpeg(args, (progress) => updateProgress(job.id, Math.min(94, Math.max(12, progress))), duration);
    const outputStat = await stat(outputPath);
    if (!outputStat.isFile() || outputStat.size < 1024) throw new Error("FFmpeg output file is missing or too small.");
    if (outputStat.size > MAX_OUTPUT_BYTES) throw new Error("MP4 exceeds the configured output limit of " + Math.round(MAX_OUTPUT_BYTES / 1024 / 1024) + " MiB.");
    await updateProgress(job.id, 96);
    const response = await apiRequest("/internal/render/jobs/" + encodeURIComponent(job.id) + "/output", {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(outputStat.size) },
      body: createReadStream(outputPath),
      duplex: "half",
      timeoutMs: 60_000,
    });
    log("render_completed", { jobId: job.id, outputSizeBytes: outputStat.size });
    return response;
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
async function updateProgress(jobId, progress) {
  const bounded = Math.min(99, Math.max(1, Math.round(progress)));
  activeProgress = bounded;
  await apiRequest("/internal/render/jobs/" + encodeURIComponent(jobId) + "/progress", {
    method: "POST",
    json: { progress: bounded },
    timeoutMs: 15_000,
  });
}
async function reportFailure(jobId, error) {
  const raw = error instanceof Error ? error.message : "Unknown render worker error";
  const code = /timed out/i.test(raw) ? "RENDER_TIMEOUT" : /limit/i.test(raw) ? "RENDER_LIMIT" : /FFmpeg/i.test(raw) ? "FFMPEG_FAILED" : "RENDER_FAILED";
  const message = raw.replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, "[redacted]").slice(0, 280);
  try {
    const response = await apiRequest("/internal/render/jobs/" + encodeURIComponent(jobId) + "/fail", {
      method: "POST",
      json: { code, message },
      timeoutMs: 15_000,
    });
    log("render_failed", { jobId, code, retrying: Boolean(response.retrying), message: message.slice(0, 100) });
  } catch (reportError) {
    log("render_failure_report_failed", { jobId, message: reportError instanceof Error ? reportError.message.slice(0, 200) : "unknown" });
  }
}
async function pollingLoop() {
  while (!stopping) {
    try {
      const response = await apiRequest("/internal/render/jobs/next", { timeoutMs: 15_000 });
      if (!response.job) {
        await sleep(Math.max(POLL_INTERVAL_MS, Number(response.pollAfterMs) || 0));
        continue;
      }
      const job = response.job;
      activeJobId = job.id;
      activeProgress = 1;
      log("render_started", { jobId: job.id, projectId: job.projectId, attempt: job.attempt });
      try {
        await renderJob(job);
      } catch (error) {
        lastError = error instanceof Error ? error.message.slice(0, 500) : "unknown";
        await reportFailure(job.id, error);
      } finally {
        activeJobId = "";
        activeProgress = 0;
      }
      await sleep(250);
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 300) : "unknown";
      log("poll_error", { message: lastError });
      await sleep(Math.max(POLL_INTERVAL_MS, 5000));
    }
  }
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    const body = JSON.stringify({ status: "ok", workerId: WORKER_ID, active: Boolean(activeJobId), activeJobId: activeJobId || null, progress: activeProgress, lastError: lastError ? lastError.slice(0, 120) : null });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
    response.end(body);
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

async function main() {
  if (!API_URL) throw new Error("HENDY_API_URL is required.");
  const parsed = new URL(API_URL);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error("HENDY_API_URL must use HTTPS outside localhost.");
  if (SERVICE_TOKEN.length < 32) throw new Error("RENDER_SERVICE_TOKEN is missing or too short.");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(HEALTH_PORT, "0.0.0.0", () => { server.off("error", reject); resolve(); });
  });
  log("worker_started", { apiUrl: API_URL, pollIntervalMs: POLL_INTERVAL_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
  process.on("SIGTERM", () => { stopping = true; log("shutdown_requested"); });
  process.on("SIGINT", () => { stopping = true; log("shutdown_requested"); });
  await pollingLoop();
  server.close();
  log("worker_stopped");
}
main().catch((error) => {
  console.error("Fatal render worker startup error:", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
});
