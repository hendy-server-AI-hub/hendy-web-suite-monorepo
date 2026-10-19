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
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
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
async function setRepoSecret(repo, name, value) {
  command("gh", ["secret", "set", name, "--repo", repo], { input: value });
  console.log("✓ Đã đặt GitHub Actions secret: " + name);
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
  console.log("Script sẽ tạo D1/R2 nếu chưa có, cấu hình wrangler.toml và khai báo GitHub Actions secrets.");
  console.log("Không đưa token vào source code, file cấu hình commit hoặc log.\n");

  const repo = await prompt("GitHub repository (owner/name)", REPO_DEFAULT);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Repository phải có dạng owner/name.");
  command("gh", ["auth", "status"]);
  command("gh", ["repo", "view", repo, "--json", "nameWithOwner"]);

  const accountId = await prompt("Cloudflare Account ID");
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Account ID phải có 32 ký tự hex.");
  const token = await secretPrompt("Cloudflare API Token");
  if (token.length < 20) throw new Error("Cloudflare API token có vẻ không hợp lệ.");
  const originInput = await prompt("Production HTTPS origin(s) (phân tách dấu phẩy, ví dụ https://admin.example.com,https://studio.example.com)");
  const origins = validOrigins(originInput);

  console.log("\nĐang xác thực Cloudflare token...");
  const verify = await cfRequest("https://api.cloudflare.com/client/v4/user/tokens/verify", token);
  if (verify?.status && verify.status !== "active") throw new Error("Cloudflare API token không active.");
  console.log("✓ Cloudflare token hợp lệ.");

  const databaseId = await ensureD1(accountId, token);
  await ensureR2(accountId, token);

  const jwtSecret = randomBytes(48).toString("base64url");
  const bootstrapKey = randomBytes(32).toString("base64url");
  const currentEnv = await readFile(ENV_FILE, "utf8").catch(() => "");
  const nextEnv = updateEnvFile(currentEnv, {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    AUTH_JWT_SECRET: jwtSecret,
    BOOTSTRAP_ADMIN_KEY: bootstrapKey,
    API_BASE_URL: "https://REPLACE_WITH_DEPLOYED_WORKER_URL",
  });
  await writeFile(ENV_FILE, nextEnv, { mode: 0o600 });
  await chmod(ENV_FILE, 0o600).catch(() => undefined);

  const configPath = resolve(ROOT, "apps/api/wrangler.toml");
  await writeFile(configPath, createWranglerConfig(databaseId, origins), "utf8");
  console.log("✓ Đã cấu hình apps/api/wrangler.toml (D1, R2, CORS allowlist).");
  console.log("✓ Đã lưu AUTH_JWT_SECRET và BOOTSTRAP_ADMIN_KEY vào .env.production.local (git-ignored).");

  await setRepoSecret(repo, "CLOUDFLARE_API_TOKEN", token);
  await setRepoSecret(repo, "CLOUDFLARE_ACCOUNT_ID", accountId);
  await setRepoSecret(repo, "AUTH_JWT_SECRET", jwtSecret);
  await setRepoSecret(repo, "BOOTSTRAP_ADMIN_KEY", bootstrapKey);

  console.log("\nĐang áp dụng D1 migrations từ cấu hình vừa tạo...");
  const npx = platform === "win32" ? "npx.cmd" : "npx";
  command(npx, ["wrangler", "d1", "migrations", "apply", DB_NAME, "--remote", "--config", "apps/api/wrangler.toml"], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
  });

  console.log("\n✓ Cloudflare resources đã sẵn sàng và GitHub secrets đã được khai báo.");
  console.log("Cấu hình local đã được cập nhật: apps/api/wrangler.toml.");
  console.log("Nếu script không tự commit/push, hãy kiểm tra thay đổi, sau đó commit và push để CI triển khai Worker.");
  console.log("Tiếp theo: sau khi Worker deploy thành công, chạy npm run bootstrap:admin để tạo tài khoản owner.");
  console.log("Lưu ý: token Cloudflare không được ghi vào file local; AUTH_JWT_SECRET và BOOTSTRAP_ADMIN_KEY nằm trong file .env.production.local — không chia sẻ file này.");
}

main().catch((error) => {
  console.error("\nBootstrap thất bại: " + (error instanceof Error ? error.message : "Lỗi không xác định."));
  process.exitCode = 1;
});
