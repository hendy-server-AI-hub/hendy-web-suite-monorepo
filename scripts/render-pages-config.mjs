import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const app = process.argv[2];
const allowed = new Set(["admin-web", "studio-web", "site"]);
if (!allowed.has(app)) throw new Error("App argument must be admin-web, studio-web or site.");
const url = String(process.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");
if (url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !["localhost","127.0.0.1"].includes(parsed.hostname)) throw new Error("API URL must use HTTPS outside localhost.");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("API URL must be an origin, not a path.");
}
const content = "window.HENDY_CONFIG = " + JSON.stringify({ apiBaseUrl: url, app, version: "2.0.0" }) + ";\n";
await writeFile(resolve("apps", app, "config.js"), content, "utf8");
console.log("Wrote public config for " + app + "; API URL is " + (url || "(unconfigured)") + ".");
