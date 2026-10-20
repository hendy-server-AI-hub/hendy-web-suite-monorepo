import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin, stdout, platform } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DEFAULT = "hendy-server-AI-hub/hendy-web-suite-monorepo";
const DB_NAME = "hendy-suite-db";
const BUCKET_NAME = "hendy-suite-assets";
const ENV_FILE = resolve(ROOT, ".env.production.local");

function prompt(message, fallback = "") {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(fallback ? message + " [" + fallback + "]: " : message + ": ", (answer) => {
      rl.close();
      resolvePrompt(answer.trim() || fallback);
    });
  });
}
function secretPrompt(message) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Chạy script trong terminal tương tác để nhập token ẩn, không echo.");
  }
  return new Promise((resolvePrompt, reject) => {
    stdout.write(message + " (input sẽ được ẩn): ");
    let value = "";
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") { cleanup(); reject(new Error("Đã hủy.")); return; }
        if (char === "\r" || char === "\n") { cleanup(); stdout.write("\n"); resolvePrompt(value); return; }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        if (char >= " " && char !== "\u007f") value += char;
      }
    };
    function cleanup() { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
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
  if (result.status !== 0) throw new Error(program + " thất bại (exit " + result.status + ").");
  return result.stdout || "";
}
async function cfRequest(baseUrl, token, method = "GET", body) {
  const response = await fetch(baseUrl, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("Cloudflare API trả về dữ liệu không đọc được: " + response.status); }
  if (!response.ok || payload.success !== true) {
    const details = Array.isArray(payload.errors) ? payload.errors.map((e) => e.message || e.code).join("; ") : "API error";
    throw new Error("Cloudflare API từ chối yêu cầu (" + response.status + "): " + details);
  }
  return payload.result;
}
async function ensureD1(accountId, token) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/d1/database";
  const result = await cfRequest(endpoint, token);
  const list = Array.isArray(result) ? result : (Array.isArray(result?.databases) ? result.databases : []);
  const existing = list.find((database) => database.name === DB_NAME);
  if (existing?.uuid || existing?.id) {
    console.log("✓ D1 database đã tồn tại: " + DB_NAME);
    return existing.uuid || existing.id;
  }
  const created = await cfRequest(endpoint, token, "POST", { name: DB_NAME });
  const databaseId = created.uuid || created.id;
  if (!databaseId) throw new Error("Cloudflare tạo D1 nhưng không trả về database ID.");
  console.log("✓ Đã tạo D1 database: " + DB_NAME);
  return databaseId;
}
async function ensureR2(accountId, token) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/r2/buckets";
  const result = await cfRequest(endpoint, token);
  const list = Array.isArray(result) ? result : (Array.isArray(result?.buckets) ? result.buckets : []);
  if (list.some((bucket) => bucket.name === BUCKET_NAME)) {
    console.log("✓ R2 bucket đã tồn tại: " + BUCKET_NAME);
    return;
  }
  await cfRequest(endpoint, token, "POST", { name: BUCKET_NAME });
  console.log("✓ Đã tạo R2 bucket: " + BUCKET_NAME);
}
async function ensurePages(accountId, token) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/pages/projects";
  const result = await cfRequest(endpoint + "?page=1&per_page=100", token);
  const projects = Array.isArray(result) ? result : (Array.isArray(result?.projects) ? result.projects : []);
  const required = [
    { name: "hendy-admin-web", label: "Admin Web" },
    { name: "hendy-studio-web", label: "Studio Web" },
    { name: "hendy-public-site", label: "Public Site" },
  ];
  const origins = [];
  for (const requiredProject of required) {
    let project = projects.find((item) => item.name === requiredProject.name);
    if (!project) {
      project = await cfRequest(endpoint, token, "POST", { name: requiredProject.name, production_branch: "main" });
      console.log("Created Cloudflare Pages project: " + requiredProject.name);
    } else {
      console.log("Cloudflare Pages project exists: " + requiredProject.name);
    }
    const subdomain = typeof project.subdomain === "string" && project.subdomain
      ? project.subdomain
      : requiredProject.name + ".pages.dev";
    const cleanSubdomain = subdomain.replace("https://", "").replace("http://", "").replaceAll("/", "");
    origins.push("https://" + cleanSubdomain);
  }
  return origins;
}
async function setRepoSecret(repo, name, value) {
  command("gh", ["secret", "set", name, "--repo", repo], { input: value });
  console.log("✓ Đã đặt GitHub Actions secret: " + name);
}
async function setRepoVariable(repo, name, value) {
  command("gh", ["variable", "set", name, "--repo", repo, "--body", value]);
  console.log("✓ Đã khai báo GitHub Actions variable: " + name);
}
function quoteToml(value) { return JSON.stringify(value); }
function createWranglerConfig(databaseId, origins) {
  return [
    'name = "hendy-suite-api"',
    'main = "src/index.ts"',
    'compatibility_date = "2026-10-01"',
    "workers_dev = true",
    "",
    "[vars]",
    'APP_NAME = "Hendy Suite API"',
    'APP_VERSION = "1.1.0"',
    'APP_ENV = "production"',
    "CORS_ORIGIN = " + quoteToml(origins.join(",")),
    "",
    "[[d1_databases]]",
    'binding = "DB"',
    'database_name = "' + DB_NAME + '"',
    'database_id = "' + databaseId + '"',
    'migrations_dir = "migrations"',
    "",
    "[[r2_buckets]]",
    'binding = "ASSETS"',
    'bucket_name = "' + BUCKET_NAME + '"',
    "",
    "[observability]",
    "enabled = true",
    "",
  ].join("\n");
}
function validOrigins(input) {
  const list = input.split(",").map((item) => item.trim()).filter(Boolean);
  if (!list.length) throw new Error("Phải cấu hình ít nhất một CORS origin.");
  for (const value of list) {
    const url = new URL(value);
    if (url.origin !== value.replace(/\/$/, "")) throw new Error("Chỉ nhập origin, không nhập path: " + value);
    if (url.protocol !== "https:") throw new Error("Production bootstrap chỉ chấp nhận origin HTTPS: " + value);
  }
  return [...new Set(list)];
}
function updateEnvFile(existing, additions) {
  const map = new Map();
  for (const line of existing.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) map.set(match[1], match[2]);
  }
  for (const [key, value] of Object.entries(additions)) map.set(key, value);
  return [...map.entries()].map(([key, value]) => key + "=" + value).join("\n") + "\n";
}

async function main() {
  console.log("\nHendy Suite — production bootstrap");
  console.log("Script sẽ tạo D1/R2/Pages nếu chưa có, cấu hình Worker, sinh secrets và khai báo GitHub Actions secrets/variables.");
  console.log("Không đưa token vào source code, file cấu hình commit hoặc log.\n");

  const repo = await prompt("GitHub repository (owner/name)", REPO_DEFAULT);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Repository phải có dạng owner/name.");
  command("gh", ["auth", "status"]);
  command("gh", ["repo", "view", repo, "--json", "nameWithOwner"]);

  const accountId = await prompt("Cloudflare Account ID");
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Account ID phải có 32 ký tự hex.");
  const token = await secretPrompt("Cloudflare API Token");
  if (token.length < 20) throw new Error("Cloudflare API token có vẻ không hợp lệ.");
  const apiBaseUrl = await prompt("Public HTTPS URL của Hendy Worker API (ví dụ https://hendy-suite-api.ten-tai-khoan.workers.dev)");
  const apiUrl = new URL(apiBaseUrl);
  if (apiUrl.protocol !== "https:" || apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash) throw new Error("API URL phải là HTTPS origin không có path/query.");

  console.log("\nĐang xác thực Cloudflare token...");
  const verify = await cfRequest("https://api.cloudflare.com/client/v4/user/tokens/verify", token);
  if (verify?.status && verify.status !== "active") throw new Error("Cloudflare API token không active.");
  console.log("✓ Cloudflare token hợp lệ.");

  const databaseId = await ensureD1(accountId, token);
  await ensureR2(accountId, token);
  const origins = validOrigins((await ensurePages(accountId, token)).join(","));
  console.log("Cloudflare Pages origins: " + origins.join(", "));

  const jwtSecret = randomBytes(48).toString("base64url");
  const bootstrapKey = randomBytes(32).toString("base64url");
  const renderServiceToken = randomBytes(48).toString("base64url");
  const renderWorkerId = "render-" + randomBytes(6).toString("hex");
  const currentEnv = await readFile(ENV_FILE, "utf8").catch(() => "");
  const nextEnv = updateEnvFile(currentEnv, {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    AUTH_JWT_SECRET: jwtSecret,
    BOOTSTRAP_ADMIN_KEY: bootstrapKey,
    RENDER_SERVICE_TOKEN: renderServiceToken,
    API_BASE_URL: apiBaseUrl,
  });
  await writeFile(ENV_FILE, nextEnv, { mode: 0o600 });
  await chmod(ENV_FILE, 0o600).catch(() => undefined);

  const configPath = resolve(ROOT, "apps/api/wrangler.toml");
  await writeFile(configPath, createWranglerConfig(databaseId, origins), "utf8");
  console.log("✓ Đã cấu hình apps/api/wrangler.toml (D1, R2, CORS allowlist).");
  console.log("✓ Đã lưu JWT/bootstrap/render secrets vào .env.production.local (git-ignored).");
  const renderEnv = [
    "HENDY_API_URL=" + apiBaseUrl,
    "RENDER_SERVICE_TOKEN=" + renderServiceToken,
    "RENDER_WORKER_ID=" + renderWorkerId,
    "POLL_INTERVAL_MS=2000",
    "JOB_TIMEOUT_MS=2700000",
    "MAX_INPUT_BYTES=262144000",
    "MAX_OUTPUT_BYTES=83886080",
    "",
  ].join("\n");
  await writeFile(resolve(ROOT, ".env.render.local"), renderEnv, { mode: 0o600 });
  await chmod(resolve(ROOT, ".env.render.local"), 0o600).catch(() => undefined);
  console.log("✓ Đã tạo .env.render.local để chạy render worker bằng Docker.");

  await setRepoSecret(repo, "CLOUDFLARE_API_TOKEN", token);
  await setRepoSecret(repo, "CLOUDFLARE_ACCOUNT_ID", accountId);
  await setRepoSecret(repo, "AUTH_JWT_SECRET", jwtSecret);
  await setRepoSecret(repo, "BOOTSTRAP_ADMIN_KEY", bootstrapKey);
  await setRepoSecret(repo, "RENDER_SERVICE_TOKEN", renderServiceToken);
  await setRepoVariable(repo, "VITE_API_BASE_URL", apiBaseUrl);
  await setRepoVariable(repo, "VITE_ADMIN_URL", origins[0]);
  await setRepoVariable(repo, "VITE_STUDIO_URL", origins[1] || origins[0]);
  await setRepoVariable(repo, "VITE_SITE_URL", origins[2] || origins[0]);

  console.log("\nĐang áp dụng D1 migrations từ cấu hình vừa tạo...");
  const npx = platform === "win32" ? "npx.cmd" : "npx";
  command(npx, ["wrangler", "d1", "migrations", "apply", DB_NAME, "--remote", "--config", "apps/api/wrangler.toml"], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
  });

  console.log("\n✓ Cloudflare resources đã sẵn sàng và GitHub secrets đã được khai báo.");
  console.log("Cấu hình local đã được cập nhật: apps/api/wrangler.toml.");
  if (process.argv.includes("--push")) {
    const branch = command("git", ["branch", "--show-current"], { capture: true }).trim();
    if (branch !== "main") throw new Error("--push yêu cầu checkout nhánh main; hiện tại là " + (branch || "(detached HEAD)") + ".");
    command("git", ["add", "apps/api/wrangler.toml"]);
    command("git", ["commit", "-m", "chore: configure production Cloudflare bindings", "--", "apps/api/wrangler.toml"]);
    command("git", ["push", "origin", "main"]);
    console.log("✓ Đã commit/push wrangler.toml; GitHub Actions sẽ chạy deploy nếu secrets hợp lệ.");
  } else {
    console.log("Để tự commit/push file cấu hình và kích hoạt CI, chạy npm run bootstrap:production:push.");
    console.log("Hoặc kiểm tra rồi commit apps/api/wrangler.toml bằng tay.");
  }
  console.log("Tiếp theo: sau khi Worker deploy thành công, chạy npm run bootstrap:admin để tạo tài khoản owner.");
  console.log("Chạy render worker trên máy chủ Docker: npm run render:up.");
  console.log("Lưu ý: token Cloudflare không được ghi vào file local; AUTH_JWT_SECRET và BOOTSTRAP_ADMIN_KEY nằm trong file .env.production.local — không chia sẻ file này.");
}

main().catch((error) => {
  console.error("\nBootstrap thất bại: " + (error instanceof Error ? error.message : "Lỗi không xác định."));
  process.exitCode = 1;
});
