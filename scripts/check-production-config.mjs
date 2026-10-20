import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const configPath = resolve(root, "apps/api/wrangler.toml");
const production = process.argv.includes("--production");
const config = await readFile(configPath, "utf8");

function tomlString(key) {
  const match = config.match(new RegExp("^\\s*" + key + "\\s*=\\s*\"([^\"]*)\"\\s*$", "m"));
  return match?.[1] || "";
}
function requireValue(condition, message) {
  if (!condition) {
    console.error("[production-config] " + message);
    process.exitCode = 1;
  }
}
function parseOrigin(name, value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(name + " is missing or not a valid URL."); }
  const canonicalValue = value.endsWith("/") ? value.slice(0, -1) : value;
  if (url.protocol !== "https:" || url.origin !== canonicalValue || url.username || url.password) {
    throw new Error(name + " must be an HTTPS origin without path, query, hash or credentials.");
  }
  return url.origin;
}

if (!production) {
  console.log("Production deployment checks skipped (pass --production to enable).");
  process.exit(0);
}

const corsOrigins = tomlString("CORS_ORIGIN").split(",").map((value) => value.trim()).filter(Boolean);
const dbName = tomlString("database_name");
const dbId = tomlString("database_id");
const r2Bucket = tomlString("bucket_name");
const rawApi = process.env.VITE_API_BASE_URL || "";
const rawAdmin = process.env.VITE_ADMIN_URL || "";
const rawStudio = process.env.VITE_STUDIO_URL || "";
const rawSite = process.env.VITE_SITE_URL || "";

requireValue(!corsOrigins.includes("*") && corsOrigins.length >= 2, "CORS_ORIGIN must be an explicit origin allowlist, not '*'.");
requireValue(config.includes('binding = "DB"') && dbName.length > 0 && /^[0-9a-f-]{36}$/i.test(dbId) && !dbId.includes("REPLACE"), "D1 binding/real database_id is missing; run npm run bootstrap:production.");
requireValue(config.includes('binding = "ASSETS"') && /^[a-z0-9-]{3,64}$/.test(r2Bucket), "R2 ASSETS binding/valid bucket_name is missing; run npm run bootstrap:production.");

try {
  const api = parseOrigin("VITE_API_BASE_URL", rawApi);
  const admin = parseOrigin("VITE_ADMIN_URL", rawAdmin);
  const studio = parseOrigin("VITE_STUDIO_URL", rawStudio);
  const site = parseOrigin("VITE_SITE_URL", rawSite);
  const configured = new Set(corsOrigins);
  for (const [label, origin] of [["Admin", admin], ["Studio", studio], ["Site", site]]) {
    requireValue(configured.has(origin), "CORS_ORIGIN does not include " + label + " origin " + origin + ".");
  }
  requireValue(api !== admin && api !== studio, "VITE_API_BASE_URL must point to the Worker API, not a frontend origin.");
  console.log("[production-config] HTTPS origins and Cloudflare bindings look valid.");
} catch (error) {
  console.error("[production-config] " + (error instanceof Error ? error.message : "Invalid production environment."));
  process.exitCode = 1;
}

if (process.exitCode) process.exit(process.exitCode);
