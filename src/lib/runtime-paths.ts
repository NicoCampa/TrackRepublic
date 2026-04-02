import path from "node:path";

const RUNTIME_ROOT = process.env.TRACK_REPUBLIC_RUNTIME_ROOT?.trim() || "";

export function resolveRuntimeScript(scriptName: string) {
  if (RUNTIME_ROOT) {
    return path.join(RUNTIME_ROOT, "defaults", "scripts", scriptName);
  }
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", scriptName);
}
