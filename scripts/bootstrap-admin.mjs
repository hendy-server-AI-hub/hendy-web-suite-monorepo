import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_FILE = resolve(ROOT, ".env.production.local");
function prompt(message, fallback = "") {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(fallback ? message + " [" + fallback + "]: " : message + ": ", (answer) => { rl.close(); resolvePrompt(answer.trim() || fallback); });
  });
}
function secretPrompt(message) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Chạy script trong terminal tương tác để nhập mật khẩu ẩn.");
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
    stdin.setRawMode(true); stdin.resume(); stdin.on("data", onData);
  });
}
function parseEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}
async function main() {
  const env = parseEnv(await readFile(SECRET_FILE, "utf8"));
  if (!env.BOOTSTRAP_ADMIN_KEY) throw new Error("Không tìm thấy BOOTSTRAP_ADMIN_KEY. Chạy npm run bootstrap:production trước.");
  const baseUrl = (await prompt("URL deployed Worker API", env.API_BASE_URL || "")).replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Dùng HTTPS cho API production.");
  const email = (await prompt("Email quản trị viên")).toLowerCase();
  const password = await secretPrompt("Mật khẩu (tối thiểu 12 ký tự)");
  const confirmation = await secretPrompt("Nhập lại mật khẩu");
  if (password !== confirmation) throw new Error("Hai mật khẩu không khớp.");
  if (password.length < 12 || password.length > 128) throw new Error("Mật khẩu phải dài từ 12 đến 128 ký tự.");

  const response = await fetch(baseUrl + "/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-key": env.BOOTSTRAP_ADMIN_KEY },
    body: JSON.stringify({ email, password }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || "HTTP " + response.status;
    throw new Error("Tạo tài khoản thất bại: " + message);
  }
  console.log("\n✓ Tài khoản owner đã được tạo: " + payload.user.email);
  console.log("Bootstrap đã bị khóa sau lần tạo đầu tiên. Đăng nhập từ giao diện có tích hợp API auth; không chia sẻ mật khẩu hoặc access token.");
}
main().catch((error) => { console.error("\nBootstrap admin thất bại: " + (error instanceof Error ? error.message : "Lỗi không xác định.")); process.exitCode = 1; });
