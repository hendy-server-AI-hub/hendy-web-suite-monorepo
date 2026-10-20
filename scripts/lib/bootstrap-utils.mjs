export const MANAGED_SECRETS = Object.freeze(["AUTH_JWT_SECRET", "BOOTSTRAP_ADMIN_KEY", "RENDER_SERVICE_TOKEN"]);

export function parseEnv(raw) {
  const values = Object.create(null);
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}
export function updateEnv(raw, additions) {
  const values = parseEnv(raw);
  for (const [key, value] of Object.entries(additions)) {
    if (!/^[A-Z0-9_]+$/.test(key)) throw new Error("Invalid environment variable name.");
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("Environment values must be single-line strings.");
    values[key] = value;
  }
  return Object.entries(values).map(([key, value]) => key + "=" + value).join("\n") + "\n";
}
export function resolveSecrets({ local = {}, remoteNames = [], rotate = false, generate = {} } = {}) {
  const remote = remoteNames instanceof Set ? remoteNames : new Set(remoteNames);
  if (!rotate) {
    const missing = MANAGED_SECRETS.filter(name => remote.has(name) && !local[name]);
    if (missing.length) throw new Error("Remote secret exists but its local backup is missing: " + missing.join(", "));
  }
  const values = Object.create(null);
  for (const name of MANAGED_SECRETS) {
    if (!rotate && local[name]) { values[name] = local[name]; continue; }
    if (typeof generate[name] !== "function") throw new Error("Missing secret generator: " + name);
    const value = generate[name]();
    if (typeof value !== "string" || value.length < 32) throw new Error("Generated secret is invalid: " + name);
    values[name] = value;
  }
  return values;
}
export function httpsOrigin(value, label = "URL") {
  let url;
  try { url = new URL(value); } catch { throw new Error(label + " must be a URL."); }
  const canonical = value.endsWith("/") ? value.slice(0, -1) : value;
  if (url.protocol !== "https:" || url.origin !== canonical || url.username || url.password) throw new Error(label + " must be an HTTPS origin without path or credentials.");
  return url.origin;
}
