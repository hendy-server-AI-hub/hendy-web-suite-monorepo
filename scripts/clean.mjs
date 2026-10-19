import { rm } from "node:fs/promises";
const targets = ["apps/admin-web/dist", "apps/studio-web/dist", "apps/site/dist", "apps/api/.wrangler", ".wrangler-dry-run"];
await Promise.all(targets.map(path => rm(path, { recursive: true, force: true })));
console.log("Removed generated build output.");
