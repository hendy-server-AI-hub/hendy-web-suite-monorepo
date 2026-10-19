import { existsSync } from "node:fs";
import { join } from "node:path";
const required = [
  ".github/workflows/deploy-cloudflare.yml",
  ".github/workflows/build-and-publish-release.yml",
  "apps/admin-web/package.json", "apps/studio-web/package.json", "apps/site/package.json",
  "apps/api/src/index.ts", "apps/api/wrangler.toml",
  "packages/core-utils/src/index.ts", "packages/shared-types/src/index.ts",
  "mobile_app/README.md", "scripts/README.md", "installer/HendyTools.iss",
  "hendy_tools_pro.py", "requirements.txt", ".npmrc", "tsconfig.json", "package.json"
];
const missing = required.filter(path => !existsSync(join(process.cwd(), path)));
if (missing.length) { console.error("Missing project paths:\n" + missing.map(path => ` - ${path}`).join("\n")); process.exit(1); }
console.log(`Structure OK: ${required.length} required paths exist.`);
