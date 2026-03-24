import { cp, mkdir, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const nextRoot = path.join(repoRoot, ".next");
const standaloneRoot = path.join(nextRoot, "standalone");
const standaloneStaticRoot = path.join(standaloneRoot, ".next", "static");
const builtStaticRoot = path.join(nextRoot, "static");
const publicRoot = path.join(repoRoot, "public");
const standalonePublicRoot = path.join(standaloneRoot, "public");
const placeholderRoot = path.join(repoRoot, "src-tauri-placeholder");

async function ensureExists(targetPath) {
  await access(targetPath);
}

async function pathExists(targetPath) {
  try {
    await ensureExists(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await pathExists(standaloneRoot))) {
    throw new Error("Next standalone output was not generated. Expected .next/standalone after build.");
  }

  await rm(standaloneStaticRoot, { recursive: true, force: true });
  await mkdir(standaloneStaticRoot, { recursive: true });
  await cp(builtStaticRoot, standaloneStaticRoot, { recursive: true });

  if (await pathExists(publicRoot)) {
    await rm(standalonePublicRoot, { recursive: true, force: true });
    await cp(publicRoot, standalonePublicRoot, { recursive: true });
  }

  await mkdir(placeholderRoot, { recursive: true });
  await writeFile(
    path.join(placeholderRoot, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Track Republic</title>
    <style>
      html, body {
        margin: 0;
        min-height: 100%;
        background: #0f131a;
        color: #f4f7fb;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      }
      body {
        display: grid;
        place-items: center;
      }
      .shell {
        display: grid;
        gap: 12px;
        text-align: center;
        padding: 24px;
      }
      .kicker {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #37d4ff;
      }
      h1 {
        margin: 0;
        font-size: 32px;
        line-height: 1;
      }
      p {
        margin: 0;
        color: #97a1af;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="kicker">Track Republic</div>
      <h1>Starting desktop app…</h1>
      <p>Launching the local production server.</p>
    </main>
  </body>
</html>`,
    "utf8",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
