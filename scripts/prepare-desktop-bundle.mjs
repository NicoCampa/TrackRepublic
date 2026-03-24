import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const nextRoot = path.join(repoRoot, ".next");
const standaloneRoot = path.join(nextRoot, "standalone");
const standaloneStaticRoot = path.join(standaloneRoot, ".next", "static");
const builtStaticRoot = path.join(nextRoot, "static");
const publicRoot = path.join(repoRoot, "public");
const standalonePublicRoot = path.join(standaloneRoot, "public");
const placeholderRoot = path.join(repoRoot, "src-tauri-placeholder");
const desktopRuntimeRoot = path.join(repoRoot, "desktop-runtime");
const appRuntimeRoot = path.join(desktopRuntimeRoot, "app-runtime");
const defaultsRoot = path.join(desktopRuntimeRoot, "defaults");
const defaultsConfigRoot = path.join(defaultsRoot, "config");
const defaultsNodeModulesRoot = path.join(defaultsRoot, "node_modules");
const defaultsScriptsRoot = path.join(defaultsRoot, "scripts");
const serverEntryPath = path.join(appRuntimeRoot, "server.js");

const SAFE_SCRIPT_NAMES = [
  "categorize_transactions.py",
  "convert_trade_republic_statement.py",
  "extract_pdf_text.mjs",
];

const SAFE_NODE_PACKAGES = [
  "pdf-parse",
  "pdfjs-dist",
  "@napi-rs/canvas",
  "@napi-rs/canvas-darwin-arm64",
];

const MANUAL_RULE_COLUMNS = [
  "id",
  "enabled",
  "name",
  "match_type",
  "pattern",
  "transaction_type",
  "amount_sign",
  "merchant",
  "group",
  "category",
  "subcategory",
  "confidence",
  "needs_review",
];

const ROW_OVERRIDE_COLUMNS = [
  "row_id",
  "description",
  "transaction_type",
  "signed_amount",
  "merchant",
  "group",
  "category",
  "subcategory",
  "confidence",
  "needs_review",
  "source",
  "updated_at",
];

const MANUAL_TRANSACTION_COLUMNS = [
  "row_id",
  "date",
  "transaction_type",
  "merchant",
  "description",
  "signed_amount",
  "category",
  "subcategory",
  "updated_at",
];

const POSITION_OVERRIDE_COLUMNS = [
  "instrument_key",
  "isin",
  "instrument",
  "units",
  "effective_date",
  "updated_at",
];

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

async function writeCsvHeader(targetPath, columns) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${columns.join(",")}\n`, "utf8");
}

async function patchStandaloneServer() {
  const serverSource = await readFile(serverEntryPath, "utf8");
  const serverPatched = serverSource.replace(
    "process.chdir(__dirname)",
    "process.chdir(process.env.TRACK_REPUBLIC_WORKSPACE || __dirname)",
  );

  if (serverSource === serverPatched) {
    throw new Error("Failed to patch standalone server cwd handling.");
  }

  await writeFile(serverEntryPath, serverPatched, "utf8");
}

async function copyNodePackage(packageName) {
  const packagePath = path.join(repoRoot, "node_modules", ...packageName.split("/"));
  const targetPath = path.join(defaultsNodeModulesRoot, ...packageName.split("/"));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(packagePath, targetPath, { recursive: true });
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

  await rm(desktopRuntimeRoot, { recursive: true, force: true });
  await cp(standaloneRoot, appRuntimeRoot, { recursive: true });
  await patchStandaloneServer();

  // Never ship traced local workspace state inside the desktop bundle.
  await rm(path.join(appRuntimeRoot, "config"), { recursive: true, force: true });
  await rm(path.join(appRuntimeRoot, "data"), { recursive: true, force: true });
  await rm(path.join(appRuntimeRoot, "scripts"), { recursive: true, force: true });
  await rm(path.join(appRuntimeRoot, "desktop-runtime"), { recursive: true, force: true });
  await rm(path.join(appRuntimeRoot, "src-tauri"), { recursive: true, force: true });
  await rm(path.join(appRuntimeRoot, "src-tauri-placeholder"), { recursive: true, force: true });

  await mkdir(defaultsConfigRoot, { recursive: true });
  await mkdir(defaultsNodeModulesRoot, { recursive: true });
  await mkdir(defaultsScriptsRoot, { recursive: true });
  await mkdir(path.join(defaultsRoot, "data", "raw"), { recursive: true });
  await mkdir(path.join(defaultsRoot, "data", "processed"), { recursive: true });

  await cp(path.join(repoRoot, "config", "instrument_registry.csv"), path.join(defaultsConfigRoot, "instrument_registry.csv"));
  await writeCsvHeader(path.join(defaultsConfigRoot, "manual_category_rules.csv"), MANUAL_RULE_COLUMNS);
  await writeCsvHeader(path.join(defaultsConfigRoot, "transaction_overrides.csv"), ROW_OVERRIDE_COLUMNS);
  await writeCsvHeader(path.join(defaultsConfigRoot, "manual_transactions.csv"), MANUAL_TRANSACTION_COLUMNS);
  await writeCsvHeader(path.join(defaultsConfigRoot, "position_unit_overrides.csv"), POSITION_OVERRIDE_COLUMNS);

  for (const scriptName of SAFE_SCRIPT_NAMES) {
    await cp(path.join(repoRoot, "scripts", scriptName), path.join(defaultsScriptsRoot, scriptName));
  }

  for (const packageName of SAFE_NODE_PACKAGES) {
    await copyNodePackage(packageName);
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
