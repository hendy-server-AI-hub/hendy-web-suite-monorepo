import test from "node:test";
import assert from "node:assert/strict";
import { allowedMediaType, parseOrigins, safeFilename, validateManifest } from "../apps/api/src/validation.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const makeManifest = () => ({ version: 1, projectId, output: { width: 1920, height: 1080, fps: 30, format: "mp4" }, tracks: [{ id: "video-1", kind: "video", clips: [{ id: "clip-1", assetId, start: 0, duration: 3 }] }] });

test("accepts valid video timeline", () => {
  const result = validateManifest(makeManifest());
  assert.equal(result.valid, true); assert.equal(result.clipCount, 1); assert.equal(result.duration, 3);
});
test("rejects invalid dimensions, IDs and timeline duration", () => {
  const dimensions = makeManifest(); dimensions.output.width = 99999; assert.equal(validateManifest(dimensions).valid, false);
  const asset = makeManifest(); asset.tracks[0].clips[0].assetId = "invalid"; assert.equal(validateManifest(asset).valid, false);
  const long = makeManifest(); long.tracks[0].clips[0].duration = 1801; assert.equal(validateManifest(long).valid, false);
});
test("rejects duplicate track IDs and empty timelines", () => {
  const duplicate = makeManifest(); duplicate.tracks.push({ id: "video-1", kind: "video", clips: [] }); assert.equal(validateManifest(duplicate).valid, false);
  const empty = makeManifest(); empty.tracks[0].clips = []; assert.equal(validateManifest(empty).valid, false);
});
test("media allowlist, filename cleanup, and origins", () => {
  assert.equal(allowedMediaType("video/mp4"), true); assert.equal(allowedMediaType("application/x-msdownload"), false);
  assert.equal(safeFilename("../../movie?.mp4"), "movie_.mp4");
  assert.deepEqual(parseOrigins("https://admin.example.test, https://studio.example.test"), ["https://admin.example.test", "https://studio.example.test"]);
});
