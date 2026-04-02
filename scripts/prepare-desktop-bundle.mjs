import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const nextRoot = path.join(repoRoot, ".next");
const standaloneRoot = path.join(nextRoot, "standalone");
const standaloneStaticRoot = path.join(standaloneRoot, ".next", "static");
const builtStaticRoot = path.join(nextRoot, "static");
const publicRoot = path.join(repoRoot, "public");
const standalonePublicRoot = path.join(standaloneRoot, "public");
const bootstrapRoot = path.join(repoRoot, "src-tauri-bootstrap");
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
  "category",
];

const ROW_OVERRIDE_COLUMNS = [
  "row_id",
  "description",
  "transaction_type",
  "signed_amount",
  "category",
  "source",
  "link_group_id",
  "link_role",
  "updated_at",
];

const MANUAL_TRANSACTION_COLUMNS = [
  "row_id",
  "date",
  "transaction_type",
  "description",
  "signed_amount",
  "category",
  "link_group_id",
  "link_role",
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

const POSITION_VALUATION_OVERRIDE_COLUMNS = [
  "instrument_key",
  "isin",
  "instrument",
  "price_eur",
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
  await rm(path.join(appRuntimeRoot, "src-tauri-bootstrap"), { recursive: true, force: true });

  await mkdir(defaultsConfigRoot, { recursive: true });
  await mkdir(defaultsNodeModulesRoot, { recursive: true });
  await mkdir(defaultsScriptsRoot, { recursive: true });
  await mkdir(path.join(defaultsRoot, "data", "raw"), { recursive: true });
  await mkdir(path.join(defaultsRoot, "data", "processed"), { recursive: true });

  await cp(path.join(repoRoot, "config", "instrument_registry.csv"), path.join(defaultsConfigRoot, "instrument_registry.csv"));
  await cp(
    path.join(repoRoot, "config", "classifier_prompt_template.txt"),
    path.join(defaultsConfigRoot, "classifier_prompt_template.txt"),
  );
  await cp(
    path.join(repoRoot, "config", "investment_asset_class_prompt_template.txt"),
    path.join(defaultsConfigRoot, "investment_asset_class_prompt_template.txt"),
  );
  await writeCsvHeader(path.join(defaultsConfigRoot, "manual_category_rules.csv"), MANUAL_RULE_COLUMNS);
  await writeCsvHeader(path.join(defaultsConfigRoot, "transaction_overrides.csv"), ROW_OVERRIDE_COLUMNS);
  await writeCsvHeader(path.join(defaultsConfigRoot, "manual_transactions.csv"), MANUAL_TRANSACTION_COLUMNS);
  await writeCsvHeader(path.join(defaultsConfigRoot, "position_unit_overrides.csv"), POSITION_OVERRIDE_COLUMNS);
  await writeCsvHeader(path.join(defaultsConfigRoot, "position_valuation_overrides.csv"), POSITION_VALUATION_OVERRIDE_COLUMNS);

  for (const scriptName of SAFE_SCRIPT_NAMES) {
    await cp(path.join(repoRoot, "scripts", scriptName), path.join(defaultsScriptsRoot, scriptName));
  }

  for (const packageName of SAFE_NODE_PACKAGES) {
    await copyNodePackage(packageName);
  }

  await mkdir(bootstrapRoot, { recursive: true });
  await writeFile(
    path.join(bootstrapRoot, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Track Republic</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b0f15;
        --bg-soft: rgba(17, 23, 33, 0.82);
        --panel: rgba(17, 23, 33, 0.78);
        --panel-border: rgba(173, 191, 214, 0.14);
        --text: #f4f7fb;
        --muted: #93a0b1;
        --accent: #52a7ff;
        --accent-soft: rgba(82, 167, 255, 0.18);
        --accent-2: #7ee0c3;
      }
      html, body {
        margin: 0;
        width: 100%;
        min-height: 100%;
        background:
          radial-gradient(circle at 18% 18%, rgba(82, 167, 255, 0.16), transparent 28%),
          radial-gradient(circle at 78% 12%, rgba(126, 224, 195, 0.10), transparent 24%),
          radial-gradient(circle at 50% 100%, rgba(82, 167, 255, 0.08), transparent 36%),
          var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", sans-serif;
      }
      body {
        position: relative;
        overflow: hidden;
      }

      body::before {
        content: "";
        position: absolute;
        inset: 24px;
        border: 1px solid rgba(173, 191, 214, 0.06);
        pointer-events: none;
      }

      .scene {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 40px 24px;
      }

      .shell {
        width: min(560px, 100%);
        display: grid;
        justify-items: center;
        gap: 18px;
        text-align: center;
      }

      .brand {
        display: inline-flex;
        align-items: center;
        gap: 14px;
        padding: 10px 14px 10px 10px;
        border: 1px solid var(--panel-border);
        background: linear-gradient(180deg, rgba(17, 23, 33, 0.86), rgba(11, 15, 21, 0.88));
        box-shadow: 0 20px 40px -34px rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }

      .brand-mark {
        width: 48px;
        height: 48px;
        display: grid;
        place-items: center;
        border: 1px solid rgba(173, 191, 214, 0.16);
        background:
          linear-gradient(180deg, rgba(82, 167, 255, 0.08), rgba(82, 167, 255, 0.02)),
          rgba(11, 15, 21, 0.92);
      }

      .brand-copy {
        display: grid;
        gap: 2px;
        text-align: left;
      }

      .brand-copy strong {
        font-size: 18px;
        line-height: 1;
        letter-spacing: -0.04em;
      }

      .brand-copy span {
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      .kicker {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.24em;
        text-transform: uppercase;
        color: var(--accent);
      }

      h1 {
        margin: 0;
        font-size: clamp(34px, 4.8vw, 52px);
        line-height: 0.96;
        letter-spacing: -0.06em;
      }

      p {
        margin: 0;
        max-width: 34ch;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.5;
      }

      .status {
        width: min(320px, 100%);
        display: grid;
        gap: 10px;
        justify-items: center;
      }

      .status-line {
        position: relative;
        width: 100%;
        height: 6px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(173, 191, 214, 0.10);
      }

      .status-line::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 34%;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--accent), var(--accent-2));
        box-shadow: 0 0 18px rgba(82, 167, 255, 0.34);
        animation: loading-slide 1.4s ease-in-out infinite;
      }

      .status-note {
        color: var(--muted);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      @keyframes loading-slide {
        0% {
          transform: translateX(-120%);
        }
        50% {
          transform: translateX(125%);
        }
        100% {
          transform: translateX(320%);
        }
      }

      @media (max-width: 720px) {
        body::before {
          inset: 14px;
        }

        .scene {
          padding: 24px;
        }

        .brand {
          padding-inline: 10px 12px;
        }

        .brand-mark {
          width: 42px;
          height: 42px;
        }

        .brand-copy strong {
          font-size: 16px;
        }

        p {
          font-size: 14px;
        }
      }
    </style>
  </head>
  <body>
    <main class="scene">
      <section class="shell" aria-live="polite">
        <div class="brand" aria-label="Track Republic">
          <div class="brand-mark" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 22H24" stroke="rgba(173,191,214,0.35)" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M6 18.5L11 14L15 16.5L21.5 8" stroke="#7EE0C3" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="21.5" cy="8" r="2" fill="#52A7FF"/>
            </svg>
          </div>
          <div class="brand-copy">
            <strong>Track Republic</strong>
            <span>Desktop</span>
          </div>
        </div>
        <div class="kicker">Launching workspace</div>
        <h1>Starting desktop app…</h1>
        <p>Preparing the local app server and opening your workspace.</p>
        <div class="status">
          <div class="status-line" aria-hidden="true"></div>
          <div class="status-note">Local server booting</div>
        </div>
      </section>
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
