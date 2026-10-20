import test from "node:test";
import assert from "node:assert/strict";
import { MANAGED_SECRETS, parseEnv, updateEnv, resolveSecrets, httpsOrigin } from "../scripts/lib/bootstrap-utils.mjs";

test("parses and safely updates a local env file", () => {
  const original = parseEnv("# ignored\nAPI_BASE_URL=https://api.example.test\nAUTH_JWT_SECRET=old\n");
  assert.equal(original.AUTH_JWT_SECRET, "old");
  const updated = parseEnv(updateEnv("API_BASE_URL=https://api.example.test\n", { AUTH_JWT_SECRET:"new", BOOTSTRAP_ADMIN_KEY:"b".repeat(40) }));
  assert.equal(updated.AUTH_JWT_SECRET, "new");
  assert.equal(updated.API_BASE_URL, "https://api.example.test");
  assert.throws(() => updateEnv("", { BAD:"one\ntwo" }), /single-line/);
});
test("preserves local secrets and fails closed if a remote secret backup is lost", () => {
  const local = Object.fromEntries(MANAGED_SECRETS.map((name,index) => [name,String(index+1).repeat(48)]));
  let generated = 0;
  const generate = Object.fromEntries(MANAGED_SECRETS.map(name => [name,() => {generated++;return "x".repeat(48);}]));
  assert.deepEqual({ ...resolveSecrets({local,remoteNames:MANAGED_SECRETS,generate}) }, local);
  assert.equal(generated,0);
  assert.throws(() => resolveSecrets({local:{},remoteNames:MANAGED_SECRETS,generate}), /local backup is missing/);
});
test("rotation is explicit and HTTPS origins reject paths and credentials", () => {
  const local = Object.fromEntries(MANAGED_SECRETS.map(name => [name,"z".repeat(48)]));
  const generate = Object.fromEntries(MANAGED_SECRETS.map((name,index) => [name,() => String(index+4).repeat(48)]));
  const fresh = resolveSecrets({local,remoteNames:MANAGED_SECRETS,rotate:true,generate});
  assert.notEqual(fresh.AUTH_JWT_SECRET,local.AUTH_JWT_SECRET);
  assert.equal(httpsOrigin("https://app.example.test/"),"https://app.example.test");
  assert.throws(() => httpsOrigin("https://app.example.test/path"),/HTTPS origin/);
  assert.throws(() => httpsOrigin("http://app.example.test"),/HTTPS origin/);
});
