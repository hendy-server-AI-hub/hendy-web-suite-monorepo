import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin, stdout, platform } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, resolveSecrets, updateEnv, httpsOrigin } from "./lib/bootstrap-utils.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DEFAULT = "hendy-server-AI-hub/hendy-web-suite-monorepo";
const DB_NAME = "hendy-control-db";
const BUCKET_NAME = "hendy-control-assets";
const ENV_FILE = resolve(ROOT, ".env.production.local");

function prompt(message, fallback = "") {
  return new Promise(resolveAnswer => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(fallback ? message + " [" + fallback + "]: " : message + ": ", answer => { rl.close(); resolveAnswer(answer.trim() || fallback); });
  });
}
function hiddenPrompt(message) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Run this command in an interactive terminal so tokens can be entered without echo.");
  return new Promise((resolveAnswer, reject) => {
    stdout.write(message + " (input hidden): ");
    let value = "";
    const onData = chunk => {
      for (const char of String(chunk)) {
        if (char === "\u0003") { cleanup(); reject(new Error("Cancelled.")); return; }
        if (char === "\r" || char === "\n") { cleanup(); stdout.write("\n"); resolveAnswer(value); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " " && char !== "\u007f") value += char;
      }
    };
    function cleanup() { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); }
    stdin.setRawMode(true); stdin.resume(); stdin.on("data", onData);
  });
}
function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    input: options.input,
    stdio: options.input !== undefined ? ["pipe", "inherit", "inherit"] : (options.capture ? ["ignore", "pipe", "inherit"] : "inherit"),
    shell: platform === "win32" && program.endsWith(".cmd"),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(program + " failed (exit " + result.status + ").");
  return result.stdout || "";
}
async function cf(url, token, method = "GET", body) {
  const response = await fetch(url, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error("Cloudflare API returned unreadable response (HTTP " + response.status + ")."); }
  if (!response.ok || data.success !== true) {
    const message = Array.isArray(data.errors) ? data.errors.map(item => item.message || item.code).join("; ") : "API error";
    throw new Error("Cloudflare API HTTP " + response.status + ": " + message);
  }
  return data.result;
}
async function ensureD1(accountId, token) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/d1/database";
  const result = await cf(endpoint, token);
  const rows = Array.isArray(result) ? result : (Array.isArray(result?.databases) ? result.databases : []);
  const existing = rows.find(item => item.name === DB_NAME);
  if (existing?.uuid || existing?.id) { console.log("D1 exists: " + DB_NAME); return existing.uuid || existing.id; }
  const created = await cf(endpoint, token, "POST", { name: DB_NAME });
  const id = created.uuid || created.id;
  if (!id) throw new Error("Cloudflare did not return a D1 database ID.");
  console.log("Created D1: " + DB_NAME); return id;
}
async function ensureR2(accountId, token) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/r2/buckets";
  const result = await cf(endpoint, token);
  const rows = Array.isArray(result) ? result : (Array.isArray(result?.buckets) ? result.buckets : []);
  if (rows.some(item => item.name === BUCKET_NAME)) { console.log("R2 bucket exists: " + BUCKET_NAME); return; }
  await cf(endpoint, token, "POST", { name: BUCKET_NAME });
  console.log("Created R2 bucket: " + BUCKET_NAME);
}
async function ensurePages(accountId, token) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/pages/projects";
  const result = await cf(endpoint + "?page=1&per_page=100", token);
  const rows = Array.isArray(result) ? result : (Array.isArray(result?.projects) ? result.projects : []);
  const required = ["hendy-admin-web", "hendy-studio-web", "hendy-public-site"];
  const origins = [];
  for (const name of required) {
    let project = rows.find(item => item.name === name);
    if (!project) { project = await cf(endpoint, token, "POST", { name, production_branch: "main" }); console.log("Created Pages project: " + name); }
    else console.log("Pages project exists: " + name);
    const subdomain = typeof project.subdomain === "string" && project.subdomain ? project.subdomain : name + ".pages.dev";
    const origin = httpsOrigin("https://" + subdomain.replace(/^https?:\/\//, "").replace(/\/+$/, ""), "Pages origin");
    origins.push(origin);
  }
  return origins;
}
async function ensureWorkersSubdomain(accountId, token) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/workers/subdomain";
  try {
    const current = await cf(endpoint, token);
    if (typeof current?.subdomain === "string" && current.subdomain) { console.log("Workers.dev subdomain: " + current.subdomain); return current.subdomain; }
  } catch { /* A new account may not have one yet. */ }
  const slug = (await prompt("Create a workers.dev subdomain; enter a lowercase slug")).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) throw new Error("Invalid workers.dev subdomain slug.");
  const result = await cf(endpoint, token, "PUT", { subdomain: slug });
  if (!result?.subdomain) throw new Error("Cloudflare did not return the created workers.dev subdomain.");
  return result.subdomain;
}
function writeWrangler(databaseId, origins) {
  const q = value => JSON.stringify(value);
  return [
    'name = "hendy-control-api"', 'main = "src/index.js"', 'compatibility_date = "2026-10-01"', "workers_dev = true", "",
    "[vars]", 'APP_NAME = "Hendy Control API"', 'APP_VERSION = "2.0.0"', 'APP_ENV = "production"',
    "CORS_ORIGINS = " + q(origins.join(",")), "", "[[d1_databases]]", 'binding = "DB"',
    'database_name = "' + DB_NAME + '"', 'database_id = "' + databaseId + '"', 'migrations_dir = "migrations"', "",
    "[[r2_buckets]]", 'binding = "ASSETS"', 'bucket_name = "' + BUCKET_NAME + '"', "",
    "[observability]", "enabled = true", "",
  ].join("\n");
}
async function setSecret(repo, name, value) {
  command("gh", ["secret", "set", name, "--repo", repo], { input: value });
  console.log("Set GitHub Actions secret: " + name);
}
function setVariable(repo, name, value) {
  command("gh", ["variable", "set", name, "--repo", repo, "--body", value]);
  console.log("Set GitHub Actions variable: " + name);
}
function remoteSecrets(repo) {
  const raw = command("gh", ["secret", "list", "--repo", repo, "--json", "name", "--limit", "100"], { capture: true });
  return new Set(JSON.parse(raw).map(row => row.name));
}
async function main() {
  console.log("\nHendy Control Suite 2.0 — production provisioning");
  const repo = await prompt("GitHub repository (owner/name)", REPO_DEFAULT);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Repository must use owner/name format.");
  command("gh", ["auth", "status"]); command("gh", ["repo", "view", repo, "--json", "nameWithOwner"]);

  const localRaw = await readFile(ENV_FILE, "utf8").catch(() => "");
  const local = parseEnv(localRaw);
  const remote = remoteSecrets(repo);
  const rotate = process.argv.includes("--rotate-secrets");
  if (rotate && await prompt("Rotation invalidates JWT sessions and worker access. Type ROTATE to continue") !== "ROTATE") throw new Error("Secret rotation cancelled.");

  const accountId = await prompt("Cloudflare Account ID");
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Cloudflare Account ID must be 32 hex characters.");
  if (local.CLOUDFLARE_ACCOUNT_ID && local.CLOUDFLARE_ACCOUNT_ID !== accountId &&
      await prompt("Local config uses a different Cloudflare account. Type SWITCH_ACCOUNT to continue") !== "SWITCH_ACCOUNT") throw new Error("Account switch cancelled.");
  const token = await hiddenPrompt("Cloudflare API token");
  if (token.length < 20) throw new Error("Cloudflare API token appears invalid.");
  const verify = await cf("https://api.cloudflare.com/client/v4/user/tokens/verify", token);
  if (verify?.status && verify.status !== "active") throw new Error("Cloudflare API token is not active.");
  console.log("Cloudflare token verified.");

  const databaseId = await ensureD1(accountId, token);
  await ensureR2(accountId, token);
  const pagesOrigins = await ensurePages(accountId, token);
  const workersSubdomain = await ensureWorkersSubdomain(accountId, token);
  const enteredUrl = await prompt("Existing HTTPS Worker URL (leave empty for automatic URL)", local.API_BASE_URL || "");
  const apiUrl = enteredUrl ? httpsOrigin(enteredUrl, "Worker API URL") : "https://hendy-control-api." + workersSubdomain + ".workers.dev";
  const secrets = resolveSecrets({
    local, remoteNames: remote, rotate,
    generate: {
      AUTH_JWT_SECRET: () => randomBytes(48).toString("base64url"),
      BOOTSTRAP_ADMIN_KEY: () => randomBytes(32).toString("base64url"),
      RENDER_SERVICE_TOKEN: () => randomBytes(48).toString("base64url"),
    },
  });
  const envContent = updateEnv(localRaw, {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    AUTH_JWT_SECRET: secrets.AUTH_JWT_SECRET,
    BOOTSTRAP_ADMIN_KEY: secrets.BOOTSTRAP_ADMIN_KEY,
    RENDER_SERVICE_TOKEN: secrets.RENDER_SERVICE_TOKEN,
    API_BASE_URL: apiUrl,
    RENDER_WORKER_ID: local.RENDER_WORKER_ID || ("render-" + randomBytes(6).toString("hex")),
  });
  await writeFile(ENV_FILE, envContent, { mode: 0o600 }); await chmod(ENV_FILE, 0o600).catch(() => undefined);
  const configPath = resolve(ROOT, "apps/api/wrangler.toml");
  await writeFile(configPath, writeWrangler(databaseId, pagesOrigins), "utf8");
  const renderEnv = updateEnv("", {
    HENDY_API_URL: apiUrl,
    RENDER_SERVICE_TOKEN: secrets.RENDER_SERVICE_TOKEN,
    RENDER_WORKER_ID: parseEnv(envContent).RENDER_WORKER_ID,
    POLL_INTERVAL_MS: "2000", JOB_TIMEOUT_MS: "2700000",
    MAX_INPUT_BYTES: "262144000", MAX_OUTPUT_BYTES: "83886080",
  });
  const renderPath = resolve(ROOT, ".env.render.local");
  await writeFile(renderPath, renderEnv, { mode: 0o600 }); await chmod(renderPath, 0o600).catch(() => undefined);

  await setSecret(repo, "CLOUDFLARE_API_TOKEN", token);
  await setSecret(repo, "CLOUDFLARE_ACCOUNT_ID", accountId);
  for (const name of Object.keys(secrets)) await setSecret(repo, name, secrets[name]);
  setVariable(repo, "VITE_API_BASE_URL", apiUrl);
  setVariable(repo, "VITE_ADMIN_URL", pagesOrigins[0]);
  setVariable(repo, "VITE_STUDIO_URL", pagesOrigins[1]);
  setVariable(repo, "VITE_SITE_URL", pagesOrigins[2]);

  console.log("Applying remote D1 migrations...");
  const npx = platform === "win32" ? "npx.cmd" : "npx";
  command(npx, ["wrangler", "d1", "migrations", "apply", DB_NAME, "--remote", "--yes", "--config", "apps/api/wrangler.toml"], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (process.argv.includes("--push")) {
    const branch = command("git", ["branch", "--show-current"], { capture: true }).trim();
    if (branch !== "main") throw new Error("--push must run on main after the rewrite is reviewed and merged.");
    const changed = command("git", ["status", "--porcelain", "--", "apps/api/wrangler.toml"], { capture: true }).trim();
    if (changed) {
      command("git", ["add", "apps/api/wrangler.toml"]);
      command("git", ["commit", "-m", "chore: configure production Cloudflare bindings", "--", "apps/api/wrangler.toml"]);
      command("git", ["push", "origin", "main"]);
    } else {
      command("gh", ["workflow", "run", "deploy-worker.yml", "--repo", repo, "--ref", "main"]);
    }
  }
  console.log("Provisioning finished. Secrets were not written to source or logs.");
  console.log("Next: npm run bootstrap:admin, then securely transfer .env.render.local to the render host.");
}
main().catch(error => { console.error("Production bootstrap failed: " + (error instanceof Error ? error.message : "unknown")); process.exitCode = 1; });
