import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { httpsOrigin } from "./lib/bootstrap-utils.mjs";

const config = await readFile(resolve("apps/api/wrangler.toml"), "utf8");
function toml(name) {
  const match = config.match(new RegExp("^\\s*" + name + "\\s*=\\s*\"([^\"]*)\"\\s*$", "m"));
  return match ? match[1] : "";
}
function requireValue(ok, message) {
  if (!ok) { console.error("[production-config] " + message); process.exitCode = 1; }
}
requireValue(config.includes('binding = "DB"') && /^[0-9a-f-]{36}$/i.test(toml("database_id")), "Missing real D1 binding/database ID.");
requireValue(config.includes('binding = "ASSETS"') && /^[a-z0-9-]{3,64}$/.test(toml("bucket_name")), "Missing R2 bucket binding.");
const origins = toml("CORS_ORIGINS").split(",").map(value => value.trim()).filter(Boolean);
requireValue(origins.length >= 3 && !origins.includes("*"), "CORS_ORIGINS must contain explicit production front-end origins.");
try {
  const api = httpsOrigin(process.env.VITE_API_BASE_URL || "", "VITE_API_BASE_URL");
  const urls = [
    ["VITE_ADMIN_URL", process.env.VITE_ADMIN_URL || ""],
    ["VITE_STUDIO_URL", process.env.VITE_STUDIO_URL || ""],
    ["VITE_SITE_URL", process.env.VITE_SITE_URL || ""],
  ].map(([name,value]) => [name, httpsOrigin(value,name)]);
  for (const [name,value] of urls) requireValue(origins.includes(value), "CORS allowlist does not include " + name + ".");
  requireValue(!urls.some(([,value]) => value === api), "API URL must not equal a static front-end URL.");
  console.log("[production-config] Real D1/R2 bindings and HTTPS origins validated.");
} catch (error) {
  console.error("[production-config] " + (error instanceof Error ? error.message : "invalid URL"));
  process.exitCode = 1;
}
if (process.exitCode) process.exit(process.exitCode);
