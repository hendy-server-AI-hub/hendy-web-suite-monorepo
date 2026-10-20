export const MANAGED_SECRET_NAMES = Object.freeze([
  "AUTH_JWT_SECRET",
  "BOOTSTRAP_ADMIN_KEY",
  "RENDER_SERVICE_TOKEN",
]);

export function parseEnvFile(raw) {
  const values = Object.create(null);
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function updateEnvFile(existing, additions) {
  const values = parseEnvFile(existing);
  for (const [key, value] of Object.entries(additions)) {
    if (!/^[A-Z0-9_]+$/.test(key)) throw new Error("Invalid environment variable name: " + key);
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
      throw new Error("Environment values must be single-line strings: " + key);
    }
    values[key] = value;
  }
  return Object.entries(values).map(([key, value]) => key + "=" + value).join("\n") + "\n";
}

export function resolveManagedSecrets({ localValues = {}, remoteSecretNames = [], rotateSecrets = false, generators = {} } = {}) {
  const remote = remoteSecretNames instanceof Set ? remoteSecretNames : new Set(remoteSecretNames);
  if (!rotateSecrets) {
    const missingLocal = MANAGED_SECRET_NAMES.filter((name) => remote.has(name) && !localValues[name]);
    if (missingLocal.length) {
      throw new Error(
        "GitHub đã có secret nhưng máy này không có bản local để tái sử dụng: " + missingLocal.join(", ") +
        ". Để tránh vô tình ghi đè secret production, hãy khôi phục .env.production.local từ bản backup an toàn hoặc chạy có chủ đích: npm run bootstrap:production -- --rotate-secrets"
      );
    }
  }

  const resolved = Object.create(null);
  for (const name of MANAGED_SECRET_NAMES) {
    if (!rotateSecrets && localValues[name]) {
      resolved[name] = localValues[name];
      continue;
    }
    const generator = generators[name];
    if (typeof generator !== "function") throw new Error("Missing secret generator for " + name);
    const value = generator();
    if (typeof value !== "string" || value.length < 32) throw new Error("Generated secret is missing or too short: " + name);
    resolved[name] = value;
  }
  return resolved;
}
