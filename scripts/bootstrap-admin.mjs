import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./lib/bootstrap-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function prompt(message, fallback = "") {
  return new Promise(resolveAnswer => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(message + (fallback ? " [" + fallback + "]" : "") + ": ", value => { rl.close(); resolveAnswer(value.trim() || fallback); });
  });
}
function hiddenPrompt(message) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Run in an interactive terminal so passwords are hidden.");
  return new Promise((resolveAnswer, reject) => {
    stdout.write(message + " (hidden): "); let value = "";
    const onData = chunk => { for (const char of String(chunk)) {
      if (char === "\u0003") { cleanup(); reject(new Error("Cancelled.")); return; }
      if (char === "\r" || char === "\n") { cleanup(); stdout.write("\n"); resolveAnswer(value); return; }
      if (char === "\u007f" || char === "\b") value = value.slice(0,-1);
      else if (char >= " " && char !== "\u007f") value += char;
    }};
    function cleanup(){stdin.off("data",onData);stdin.setRawMode(false);stdin.pause();}
    stdin.setRawMode(true);stdin.resume();stdin.on("data",onData);
  });
}
async function main() {
  const values = parseEnv(await readFile(resolve(root, ".env.production.local"), "utf8"));
  if (!values.BOOTSTRAP_ADMIN_KEY) throw new Error("Missing BOOTSTRAP_ADMIN_KEY; run production bootstrap first.");
  const baseUrl = (await prompt("Worker API HTTPS origin", values.API_BASE_URL)).replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["localhost","127.0.0.1"].includes(url.hostname)) throw new Error("Production API must use HTTPS.");
  const email = (await prompt("Owner email")).trim().toLowerCase();
  const password = await hiddenPrompt("Password (12-128 characters)");
  const repeated = await hiddenPrompt("Repeat password");
  if (password !== repeated) throw new Error("Passwords do not match.");
  if (password.length < 12 || password.length > 128) throw new Error("Password must be 12-128 characters.");
  const response = await fetch(baseUrl + "/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-key": values.BOOTSTRAP_ADMIN_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || "Owner bootstrap failed with HTTP " + response.status);
  console.log("Owner created: " + data.user.email + ". Bootstrap endpoint is now locked.");
}
main().catch(error => { console.error("Admin bootstrap failed: " + (error instanceof Error ? error.message : "unknown")); process.exitCode = 1; });
