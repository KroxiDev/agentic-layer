import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { protocolPackageFiles } from "../.agents/kernel/protocol-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SYNTAX_CHECK_FILES = Object.freeze(
  protocolPackageFiles().filter((path) => path.endsWith(".mjs")),
);

export function runSyntaxChecks() {
  for (const relativePath of SYNTAX_CHECK_FILES) {
    const result = spawnSync(
      process.execPath,
      ["--check", join(ROOT, ...relativePath.split("/"))],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout || `Falló node --check para ${relativePath}.\n`);
      return result.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runSyntaxChecks();
}
