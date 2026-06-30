import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "out");
const target = resolve(root, "..", "cloudflare-worker", "public");

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

console.log(`Copied static Next export to ${target}`);
