import assert from "node:assert/strict";
import { MANAGED_SECRET_NAMES, parseEnvFile, updateEnvFile, resolveManagedSecrets } from "./bootstrap-utils.mjs";

const sample = parseEnvFile("# comment\nAUTH_JWT_SECRET=alpha\nAPI_BASE_URL=https://api.example.test\nBROKEN LINE\n");
assert.equal(sample.AUTH_JWT_SECRET, "alpha");
assert.equal(sample.API_BASE_URL, "https://api.example.test");
assert.equal(sample["BROKEN LINE"], undefined);

const updated = updateEnvFile("A=1\nAUTH_JWT_SECRET=old\n# retained as a comment? parser intentionally ignores comments\n", {
  AUTH_JWT_SECRET: "replacement",
  NEW_VALUE: "safe-value",
});
assert.deepEqual({ ...parseEnvFile(updated) }, { A: "1", AUTH_JWT_SECRET: "replacement", NEW_VALUE: "safe-value" });
assert.throws(() => updateEnvFile("", { BAD: "line1\nline2" }), /single-line/);

const reusableValues = {
  AUTH_JWT_SECRET: "a".repeat(64),
  BOOTSTRAP_ADMIN_KEY: "b".repeat(64),
  RENDER_SERVICE_TOKEN: "c".repeat(64),
};
let generatorCalls = 0;
const generators = Object.fromEntries(MANAGED_SECRET_NAMES.map((name, i) => [
  name,
  () => { generatorCalls++; return String(i + 1).repeat(64); },
]));
const reused = resolveManagedSecrets({
  localValues: reusableValues,
  remoteSecretNames: new Set(MANAGED_SECRET_NAMES),
  generators,
});
assert.deepEqual({ ...reused }, reusableValues);
assert.equal(generatorCalls, 0, "reruns must reuse local secrets, never silently rotate");

assert.throws(() => resolveManagedSecrets({
  localValues: { AUTH_JWT_SECRET: reusableValues.AUTH_JWT_SECRET },
  remoteSecretNames: new Set(MANAGED_SECRET_NAMES),
  generators,
}), /machine|máy này|không có bản local/i, "fail closed when the remote secret exists but local recovery is missing");

const fresh = resolveManagedSecrets({ localValues: {}, remoteSecretNames: [], generators });
assert.equal(Object.keys(fresh).length, 3);
assert.equal(generatorCalls, 3);
assert.ok(Object.values(fresh).every((value) => value.length >= 32));

generatorCalls = 0;
const rotated = resolveManagedSecrets({
  localValues: reusableValues,
  remoteSecretNames: new Set(MANAGED_SECRET_NAMES),
  rotateSecrets: true,
  generators,
});
assert.equal(generatorCalls, 3, "explicit rotation must generate fresh values");
for (const name of MANAGED_SECRET_NAMES) assert.notEqual(rotated[name], reusableValues[name]);

assert.throws(() => resolveManagedSecrets({ generators: {} }), /Missing secret generator/);
console.log("Bootstrap utility tests passed: env parsing, safe writes, stable secrets, fail-closed reruns and explicit rotation.");
