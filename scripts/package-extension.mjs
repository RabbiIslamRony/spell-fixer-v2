import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");
const stageDir = path.join(distDir, "grammar-assistant-extension");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version || "0.0.0";
const zipName = `grammar-assistant-extension-v${version}.zip`;
const zipPath = path.join(distDir, zipName);

const packageFiles = [
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "popup.css",
  "options.html",
  "options.css",
  "USER_SETUP.md",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
];

const excludedFromZip = [
  ".git/",
  "cloudflare-worker/",
  "server-example/",
  "node_modules/",
  "dist/",
  "README.md",
  "QA_CHECKLIST.md",
  "package.json",
  "scripts/"
];

fs.rmSync(stageDir, { force: true, recursive: true });
fs.mkdirSync(stageDir, { recursive: true });

for (const file of packageFiles) {
  const source = path.join(root, file);
  const target = path.join(stageDir, file);

  if (!fs.existsSync(source)) {
    throw new Error(`Missing package file: ${file}`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

fs.writeFileSync(
  path.join(stageDir, "PACKAGE_CONTENTS.txt"),
  [
    "Grammar Assistant Chrome extension package",
    "",
    "Included runtime files:",
    ...packageFiles.map((file) => `- ${file}`),
    "",
    "Intentionally excluded from this ZIP:",
    ...excludedFromZip.map((file) => `- ${file}`),
    "",
    "Install: unzip this package, then load the extracted folder from chrome://extensions."
  ].join("\n")
);

fs.rmSync(zipPath, { force: true });
execFileSync("zip", ["-qr", zipPath, "."], { cwd: stageDir, stdio: "inherit" });

const stats = fs.statSync(zipPath);
console.log(`Created ${zipPath}`);
console.log(`Size: ${(stats.size / 1024).toFixed(1)} KB`);
console.log(`Staged folder: ${stageDir}`);
