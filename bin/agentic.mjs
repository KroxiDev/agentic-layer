#!/usr/bin/env node

import { printHelp, readDistributionVersion, runCli } from "../scripts/agentic-init.mjs";

const USAGE = `Uso: agentic <subcomando> [opciones]

Subcomandos:
  init [destino]        Adopta la capa agéntica en el destino indicado.

Opciones globales:
  -v, --version         Muestra la versión de la distribución.
  -h, --help            Muestra esta ayuda.

Ejemplos:
  npx --yes github:KroxiDev/agentic-layer init .
  npx --yes github:KroxiDev/agentic-layer init . --dry-run
  agentic init . --yes
  agentic init . --yes --purpose "<propósito>" --git-strategy "<estrategia>"`;

const argv = process.argv.slice(2);
const [subcommand, ...rest] = argv;

if (subcommand === "init") {
  await runCli(rest, "agentic init");
} else if (subcommand === "--version" || subcommand === "-v") {
  console.log(await readDistributionVersion());
} else if (subcommand === "--help" || subcommand === "-h") {
  console.log(USAGE);
  console.log("");
  printHelp("agentic init");
} else if (!subcommand) {
  console.error("ERROR: falta un subcomando. Use `agentic init [destino]`.");
  console.error(USAGE);
  process.exitCode = 1;
} else {
  console.error(`ERROR: subcomando desconocido: ${subcommand}.`);
  console.error(USAGE);
  process.exitCode = 1;
}
