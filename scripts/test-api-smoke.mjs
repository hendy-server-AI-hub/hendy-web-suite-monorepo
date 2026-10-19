import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const port = 8976;
const base = "http://127.0.0.1:" + port;
const child = spawn(command, ["wrangler", "dev", "--local", "--port", String(port), "--config", "apps/api/wrangler.toml"], {
  cwd: root,
  env: { ...process.env, NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
const closed = new Promise((resolveClose) => child.once("close", (code, signal) => resolveClose({ code, signal })));
let logs = "";
child.stdout.on("data", (chunk) => { logs += String(chunk); });
child.stderr.on("data", (chunk) => { logs += String(chunk); });

async function request(path, init) {
  const response = await fetch(base + path, init);
  const body = await response.json().catch(() => null);
  return { response, body };
}
async function waitForServer() {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error("Wrangler exited early.");
    try { const response = await fetch(base + "/healthz"); if (response.ok) return; } catch { /* not ready */ }
    await delay(300);
  }
  throw new Error("Worker did not become ready within 20 seconds.");
}
function assert(condition, message) { if (!condition) throw new Error(message); }

try {
  await waitForServer();
  const health = await request("/healthz");
  assert(health.response.status === 200 && health.body?.status === "ok", "healthz failed");
  assert(health.response.headers.get("x-request-id"), "request ID header missing");
  console.log("PASS GET /healthz");

  const meta = await request("/api/v1/meta");
  assert(meta.response.status === 200 && meta.body?.name, "metadata failed");
  console.log("PASS GET /api/v1/meta");

  const manifest = {
    version: 1,
    projectId: "smoke-test-project",
    output: { width: 1920, height: 1080, fps: 24, format: "mp4" },
    tracks: [{ id: "v1", kind: "video", clips: [{ id: "clip-1", assetId: "asset-smoke", start: 0, duration: 2 }] }],
  };
  const valid = await request("/api/v1/render/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(manifest),
  });
  assert(valid.response.status === 200 && valid.body?.valid === true && valid.body?.clipCount === 1, "valid manifest was not accepted");
  console.log("PASS POST /api/v1/render/validate (valid manifest)");

  const invalid = await request("/api/v1/render/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 9 }),
  });
  assert(invalid.response.status === 422 && invalid.body?.error?.code === "INVALID_MANIFEST", "invalid manifest was not rejected");
  console.log("PASS POST /api/v1/render/validate (invalid manifest rejected)");

  const badOrigin = await request("/api/v1/meta", { headers: { origin: "https://untrusted.invalid" } });
  assert(badOrigin.response.status === 403, "untrusted CORS origin was not rejected");
  console.log("PASS CORS allowlist");

  const authNotReady = await request("/api/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "not-a-real-password" }),
  });
  assert(authNotReady.response.status === 503, "auth should fail closed before D1/secrets are configured");
  console.log("PASS auth fails closed without production bindings");
} catch (error) {
  console.error("API smoke test failed:", error instanceof Error ? error.message : error);
  console.error(logs.slice(-7000));
  process.exitCode = 1;
} finally {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* process can already be gone */ }
  const stopped = await Promise.race([closed.then(() => true), delay(2500).then(() => false)]);
  if (!stopped) {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* process can already be gone */ }
    await Promise.race([closed, delay(1500)]);
  }
}
