#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, parse, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

import { assertProtocolConformance } from "../.agents/conformance/protocol-conformance.mjs";
import {
  PROTOCOL_MANIFEST,
  protocolArtifactPaths,
  protocolAssetSources,
  protocolPackageFiles,
  protocolRoleNames,
} from "../.agents/kernel/protocol-manifest.mjs";

const CONTRACT_START = "<!-- AGENTIC_PROJECT_CONTRACT_START -->";
const CONTRACT_END = "<!-- AGENTIC_PROJECT_CONTRACT_END -->";
const GENERATED_CONTRACT_MARKER = "<!-- AGENTIC_PROJECT_CONTRACT_GENERATED -->";
const GOLDEN_RULE_POLICY = ".agents/policies/regla-de-oro.md";
const ORCHESTRATION_POLICY = ".agents/policies/orquestacion.md";
const GOLDEN_RULE_DEVELOPMENT_BULLET =
  `- Antes de agregar o modificar código o pruebas, leer y aplicar \`${GOLDEN_RULE_POLICY}\`, tanto en tareas directas como orquestadas.`;
const GOLDEN_RULE_DEVELOPMENT = `## Desarrollo

${GOLDEN_RULE_DEVELOPMENT_BULLET}`;
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_FILES = protocolArtifactPaths();
// npm descarta los `.gitignore` anidados al empaquetar, así que el protocolo
// declara el asset neutro que el inicializador restaura con su nombre canónico.
const TEMPLATE_ASSET_SOURCES = protocolAssetSources();
// npm renombra a `.npmignore` cualquier `.gitignore` empaquetado, así que la
// higiene de este repositorio no puede formar parte de la distribución.
const DEVELOPMENT_FILES = [
  ".gitignore",
  "tests/agentic-init.test.mjs",
  "tests/agentic-test-helpers.mjs",
  "tests/agentic-update.test.mjs",
  "tests/codex-config.test.mjs",
  "tests/distribution-contracts.test.mjs",
  "tests/orchestration-kernel.test.mjs",
];
const PACKAGE_FILES = protocolPackageFiles();

function templateSourcePath(relativePath) {
  const source = TEMPLATE_ASSET_SOURCES.get(relativePath) ?? relativePath;
  return join(SOURCE_ROOT, ...source.split("/"));
}

function markdownLinkTargets(source) {
  return [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) =>
    match[1].trim().replace(/^<|>$/g, "").replaceAll("\\", "/"),
  );
}

function linksToCanonicalPolicy(source) {
  return markdownLinkTargets(source).some((target) =>
    target.split("#")[0].endsWith("policies/orquestacion.md"),
  );
}

// Archivo generado, no distribuido: registra qué versión de la capa quedó
// instalada para poder comparar en una adopción posterior.
const LAYER_VERSION_FILE = ".agents/VERSION";
// Señales de que el destino ya tiene una capa agéntica. Basta una para tratar
// las divergencias como reemplazo de una instalación previa y no como una
// colisión con archivos ajenos del proyecto.
const LAYER_MARKERS = [...PROTOCOL_MANIFEST.layerMarkers];
// Directorios cuyo contenido gestiona por completo la capa: al reemplazar, todo
// archivo que no pertenezca a la distribución es residuo de otra versión.
// `.agents/sessions/` queda fuera porque guarda DevSessions del propietario, y
// la raíz de `.agents/` porque aloja el VERSION generado.
const MANAGED_DIRECTORIES = [...PROTOCOL_MANIFEST.managedDirectories];
// Rutas que solo existen en el checkout de desarrollo: la distribución no las
// transporta, así que sus enlaces se comprueban únicamente donde existen.
const DEVELOPMENT_ONLY_PREFIXES = ["CONTEXT.md", "docs/", "tests/"];
const ROLE_NAMES = protocolRoleNames();
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const EXIT_REQUIREMENTS_MISSING = 4;

const IGNORED_SCAN_DIRECTORIES = new Set([
  ".agents",
  ".claude",
  ".codegraph",
  ".codex",
  ".engram",
  ".git",
  "node_modules",
]);

function parseArguments(argv, operation = "init") {
  const options = {
    destination: process.cwd(),
    dryRun: false,
    force: false,
    nonInteractive: false,
    operation,
    yes: false,
  };
  let positionalDestination = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      const value = argv[index + 1];
      if (!value) throw new Error("Falta el valor de --target.");
      options.destination = value;
      positionalDestination = true;
      index += 1;
    } else if (argument === "--purpose") {
      const value = argv[index + 1];
      if (!value) throw new Error("Falta el valor de --purpose.");
      options.purpose = value.trim();
      index += 1;
    } else if (argument === "--git-strategy") {
      const value = argv[index + 1];
      if (!value) throw new Error("Falta el valor de --git-strategy.");
      options.gitStrategy = value.trim();
      index += 1;
    } else if (argument === "--init-codegraph") {
      if (options.codeGraphAction && options.codeGraphAction !== "init") {
        throw new Error("--init-codegraph y --update-codegraph no pueden combinarse.");
      }
      options.codeGraphAction = "init";
    } else if (argument === "--update-codegraph") {
      if (options.codeGraphAction && options.codeGraphAction !== "sync") {
        throw new Error("--init-codegraph y --update-codegraph no pueden combinarse.");
      }
      options.codeGraphAction = "sync";
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--allow-downgrade") {
      options.allowDowngrade = true;
    } else if (argument === "--codex-config") {
      const value = argv[index + 1];
      if (!value || !["global", "local", "none"].includes(value)) {
        throw new Error("--codex-config exige global, local o none.");
      }
      options.codexConfig = value;
      index += 1;
    } else if (argument === "--yes" || argument === "-y" || argument === "--non-interactive") {
      options.nonInteractive = true;
      options.yes = true;
    } else if (argument === "--version" || argument === "-v") {
      options.version = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Opción desconocida: ${argument}`);
    } else if (!positionalDestination) {
      options.destination = argument;
      positionalDestination = true;
    } else {
      throw new Error(`Argumento inesperado: ${argument}`);
    }
  }

  if (!options.purpose && Object.hasOwn(options, "purpose")) {
    throw new Error("--purpose no puede estar vacío.");
  }
  if (!options.gitStrategy && Object.hasOwn(options, "gitStrategy")) {
    throw new Error("--git-strategy no puede estar vacío.");
  }
  for (const [flag, value] of [
    ["--purpose", options.purpose],
    ["--git-strategy", options.gitStrategy],
  ]) {
    if (value && (/\r|\n/.test(value) || value.includes(CONTRACT_START) || value.includes(CONTRACT_END))) {
      throw new Error(`${flag} debe ser texto de una sola línea sin marcadores contractuales.`);
    }
  }
  if (operation !== "update" && (options.allowDowngrade || options.codexConfig)) {
    throw new Error("--allow-downgrade y --codex-config solo se admiten con agentic update.");
  }
  options.destination = resolve(options.destination);
  return options;
}

function printHelp(invocation = "node scripts/agentic-init.mjs", operation = "init") {
  console.log(`Uso: ${invocation} [destino] [opciones]

Opciones:
  --target <ruta>       Directorio destino; por defecto, el actual.
  --purpose <texto>     Atajo para declarar el propósito en vez de dejarlo
                        pendiente en el contrato.
  --git-strategy <txt>  Atajo para declarar la estrategia Git en vez de dejarla
                        pendiente en el contrato.
  --dry-run             Muestra las acciones sin escribir.
  -y, --yes             Omite la confirmación general previa a escribir. No
                        resuelve entradas contractuales no mapeables.
  --non-interactive     Alias de compatibilidad de --yes.
  --force               Reemplaza una capa instalada sin preguntar: sobrescribe
                        archivos canónicos divergentes y elimina residuos de
                        otras versiones. Nunca toca AGENTS.md fuera del
                        contrato, DevSessions, enlaces ni directorios ajenos.
${operation === "update" ? `  --allow-downgrade     Autoriza instalar una versión anterior a la declarada.
  --codex-config <nivel> Autoriza configurar Codex en global, local o none.
` : ""}  --init-codegraph      Confirma explícitamente inicializar CodeGraph.
  --update-codegraph    Confirma explícitamente sincronizar CodeGraph.
  -v, --version         Muestra la versión de la distribución.
  -h, --help            Muestra esta ayuda.

Los hechos que no puedan inferirse quedan marcados como <pendiente: …> en el
contrato de AGENTS.md y se listan al terminar. Durante update, una entrada
contractual no mapeable exige una decisión interactiva explícita.

Códigos de salida: 0 correcto, 1 error de uso, 2 bloqueo seguro sin escrituras,
3 cancelado por el usuario, 4 capa instalada con CodeGraph o Engram ausentes.`);
}

async function readDistributionVersion() {
  const manifest = JSON.parse(await readFile(join(SOURCE_ROOT, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("package.json de la distribución no declara una versión.");
  }
  return manifest.version.trim();
}

function parseSemVer(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    value,
  );
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
    )
  ) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareSemVer(leftValue, rightValue) {
  const left = parseSemVer(leftValue);
  const right = parseSemVer(rightValue);
  if (!left || !right) throw new Error("No se pueden comparar versiones SemVer inválidas.");
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = left.prerelease[index];
    const rightId = right.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    if (leftId === rightId) continue;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) return Number(leftId) < Number(rightId) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftId < rightId ? -1 : 1;
  }
  return 0;
}

function assertSafeDestination(destination) {
  const root = parse(destination).root;
  if (destination === root || destination === resolve(homedir())) {
    throw new Error("El destino no puede ser la raíz del sistema ni el directorio personal.");
  }
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function changedAfterPlan(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

async function assertAbsentFile(path, label) {
  if (await pathState(path)) {
    throw changedAfterPlan(`${label} apareció después del plan; no se escribió ningún archivo.`);
  }
}

async function assertExpectedRegularFile(path, expectedContent, expectedState, label) {
  const before = await pathState(path);
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    !sameFileIdentity(before, expectedState)
  ) {
    throw changedAfterPlan(`${label} cambió después del plan; no se escribió ningún archivo.`);
  }
  const content = await readFile(path);
  const after = await pathState(path);
  const expected = Buffer.isBuffer(expectedContent)
    ? expectedContent
    : Buffer.from(expectedContent, "utf8");
  if (!after?.isFile() || after.isSymbolicLink() || !sameFileIdentity(before, after) || !content.equals(expected)) {
    throw changedAfterPlan(`${label} cambió después del plan; no se escribió ningún archivo.`);
  }
  return after;
}

async function writeSiblingTemporary(path, content, mode = null) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.agentic-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(temporary, content, { flag: "wx" });
  if (mode !== null) await chmod(temporary, mode);
  return { temporary, state: await lstat(temporary) };
}

async function atomicCreateNoFollow(
  path,
  content,
  mode = null,
  label = path,
  assertSafeParent = null,
) {
  if (assertSafeParent) await assertSafeParent();
  const { temporary, state } = await writeSiblingTemporary(path, content, mode);
  try {
    await assertAbsentFile(path, label);
    if (assertSafeParent) await assertSafeParent();
    await link(temporary, path);
    return state;
  } catch (error) {
    if (error.code === "EEXIST") throw changedAfterPlan(`${label} apareció después del plan; no se escribió ningún archivo.`);
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function atomicReplaceNoFollow(
  path,
  expectedContent,
  expectedState,
  content,
  mode,
  label,
  assertSafeParent = null,
) {
  if (assertSafeParent) await assertSafeParent();
  const { temporary, state } = await writeSiblingTemporary(path, content, mode);
  try {
    await assertExpectedRegularFile(path, expectedContent, expectedState, label);
    if (assertSafeParent) await assertSafeParent();
    await rename(temporary, path);
    return state;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function unsafeDestinationParent(destination, relativePath) {
  const segments = relativePath.split("/").slice(0, -1);
  let current = destination;
  for (const segment of segments) {
    current = join(current, segment);
    const state = await pathState(current);
    if (!state) return null;
    if (state.isSymbolicLink() || !state.isDirectory()) {
      return relative(destination, current).replaceAll("\\", "/");
    }
  }
  return null;
}

async function assertSafeDestinationAncestors(destination) {
  const root = parse(destination).root;
  const segments = relative(root, destination).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const state = await pathState(current);
    if (!state) return;
    if (state.isSymbolicLink()) {
      throw new Error(`El destino atraviesa un enlace simbólico no seguro: ${current}`);
    }
    if (!state.isDirectory() && current !== destination) {
      throw new Error(`Un ancestro del destino no es un directorio: ${current}`);
    }
  }
}

async function listProjectFiles(root) {
  const files = [];

  async function visit(directory, depth) {
    if (depth > 6 || files.length >= 10_000) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (files.length >= 10_000) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth === 0 && IGNORED_SCAN_DIRECTORIES.has(entry.name)) continue;
        await visit(join(directory, entry.name), depth + 1);
      } else if (entry.isFile()) {
        files.push(relative(root, join(directory, entry.name)).replaceAll("\\", "/"));
      }
    }
  }

  await visit(root, 0);
  return files;
}

// Las herramientas nativas de Windows escriben UTF-8 con BOM; los archivos de
// detección deben leerse igual en las tres plataformas.
function withoutByteOrderMark(content) {
  return content.replace(/^﻿/, "");
}

async function readPackage(destination, warnings) {
  const packagePath = join(destination, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    return JSON.parse(withoutByteOrderMark(await readFile(packagePath, "utf8")));
  } catch (error) {
    warnings.push(`No se pudo interpretar package.json: ${error.message}`);
    return null;
  }
}

async function readOptionalText(destination, relativePath, warnings) {
  const absolutePath = join(destination, ...relativePath.split("/"));
  if (!existsSync(absolutePath)) return null;
  try {
    return withoutByteOrderMark(await readFile(absolutePath, "utf8"));
  } catch (error) {
    warnings.push(`No se pudo leer ${relativePath}: ${error.message}`);
    return null;
  }
}

function tomlSection(content, sectionName) {
  if (!content) return null;
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\[${escapedName}\\]\\s*$`, "m").exec(content);
  if (!match) return null;
  const rest = content.slice(match.index + match[0].length);
  const nextSection = /^\s*\[[^\]]+\]\s*$/m.exec(rest);
  return nextSection ? rest.slice(0, nextSection.index) : rest;
}

function tomlString(section, key) {
  if (!section) return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escapedKey}\\s*=\\s*(["'])(.*?)\\1\\s*$`, "m").exec(
    section,
  );
  return match?.[2]?.trim() || null;
}

function packageScriptCommand(packageManager, name) {
  if (packageManager === "npm") return name === "test" ? "npm test" : `npm run ${name}`;
  return `${packageManager} ${name}`;
}

function describeCommands(commands, fallback) {
  const unique = [...new Set(commands.filter(Boolean))];
  if (!unique.length) return fallback;
  return `ejecutar ${unique.map((command) => `\`${command}\``).join(" y ")}.`;
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// Primer párrafo de prosa del README: la frase que describe el proyecto.
async function readReadmePurpose(destination, warnings) {
  const readmePath = join(destination, "README.md");
  if (!existsSync(readmePath)) return null;
  try {
    const content = withoutByteOrderMark(await readFile(readmePath, "utf8"));
    for (const block of content.split(/\r?\n\s*\r?\n/)) {
      const normalized = block.replace(/\r?\n/g, " ").trim();
      if (
        !normalized ||
        /^(#|```|~~~|<!--|\||[-*+]\s|\d+\.\s|!\[|\[!\[)/.test(normalized)
      ) {
        continue;
      }
      return normalized
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`]/g, "")
        .trim();
    }
    return null;
  } catch (error) {
    warnings.push(`No se pudo leer README.md: ${error.message}`);
    return null;
  }
}

function quotePaths(paths) {
  return paths.map((path) => `\`${path}\``).join(", ");
}

// Marcador de un campo contractual que el inicializador no puede inferir. Su
// forma cerrada `<pendiente: ...>` casa con `isMissingContractValue`, así que la
// regla STRICT_PROJECT_CONTRACT_RULE de `.agents/policies/orquestacion.md` lo
// cobra como contrato incompleto y detiene cualquier tarea orquestada. La
// primera sesión del agente lo completa con la skill `agentic-grilling`.
function pendingField(hint) {
  return `<pendiente: ${hint}>`;
}

// Valores recomendados por ecosistema. Sustituyen a los textos genéricos para
// que la cantidad de campos pendientes tienda a cero cuando el repositorio
// declara metadatos reconocibles.
const RECOMMENDED_DOCUMENTATION = "mantener `README.md` en la raíz";
const ECOSYSTEM_PROFILES = new Map([
  [
    "node",
    {
      focusedValidation:
        "ejecutar `node --check` sobre los archivos modificados y `node --test` sobre las pruebas relacionadas.",
      completeValidation: "ejecutar `node --test` sobre toda la suite.",
      testFramework: "`node:test`",
      testLocation: "`tests/`",
    },
  ],
  [
    "python",
    {
      focusedValidation:
        "ejecutar `python -m compileall` sobre los archivos modificados y `python -m pytest` sobre las pruebas relacionadas.",
      completeValidation: "ejecutar `python -m pytest`.",
      testFramework: "`pytest`",
      testLocation: "`tests/`",
    },
  ],
  [
    "rust",
    {
      focusedValidation: "ejecutar `cargo check` sobre el paquete afectado.",
      completeValidation: "ejecutar `cargo test`.",
      testFramework: "`cargo test`",
      testLocation: "`tests/` y los módulos `#[cfg(test)]` del propio código",
    },
  ],
  [
    "go",
    {
      focusedValidation:
        "ejecutar `go build ./...` y `go test` sobre los paquetes afectados.",
      completeValidation: "ejecutar `go test ./...`.",
      testFramework: "`go test`",
      testLocation: "los archivos `*_test.go` junto a cada paquete",
    },
  ],
]);

function detectEcosystem(files, { cargo, pyproject }) {
  if (files.includes("package.json")) return "node";
  if (cargo) return "rust";
  if (files.includes("go.mod")) return "go";
  if (
    pyproject ||
    files.includes("setup.py") ||
    files.includes("setup.cfg") ||
    files.includes("requirements.txt") ||
    files.some((file) => file.endsWith(".py"))
  ) {
    return "python";
  }
  return null;
}

async function detectProject(destination, warnings) {
  const [packageJson, readmePurpose, pyproject, cargo] = await Promise.all([
    readPackage(destination, warnings),
    readReadmePurpose(destination, warnings),
    readOptionalText(destination, "pyproject.toml", warnings),
    readOptionalText(destination, "Cargo.toml", warnings),
  ]);
  const files = await listProjectFiles(destination);
  const ecosystem = detectEcosystem(files, { cargo, pyproject });
  const profile = ecosystem ? ECOSYSTEM_PROFILES.get(ecosystem) : null;
  const pythonProject = tomlSection(pyproject, "project") ?? tomlSection(pyproject, "tool.poetry");
  const cargoPackage = tomlSection(cargo, "package");
  const manifestPurpose =
    tomlString(pythonProject, "description") ?? tomlString(cargoPackage, "description");
  const purpose =
    typeof packageJson?.description === "string" && packageJson.description.trim()
      ? packageJson.description.replace(/\s+/g, " ").trim()
      : manifestPurpose ?? readmePurpose;

  const entrypoints = [];
  for (const candidate of [packageJson?.main, packageJson?.module]) {
    if (typeof candidate === "string" && candidate.trim()) entrypoints.push(candidate.trim());
  }
  if (packageJson?.bin && typeof packageJson.bin === "string") {
    entrypoints.push(packageJson.bin);
  } else if (packageJson?.bin && typeof packageJson.bin === "object") {
    entrypoints.push(...Object.values(packageJson.bin).filter((value) => typeof value === "string"));
  }
  const pythonScripts = tomlSection(pyproject, "project.scripts");
  if (pythonScripts) {
    for (const match of pythonScripts.matchAll(
      /^\s*([A-Za-z0-9_.-]+)\s*=\s*(["'])(.*?)\2\s*$/gm,
    )) {
      entrypoints.push(`${match[1]} → ${match[3]}`);
    }
  }
  for (const candidate of ["main.py", "app.py", "src/main.rs", "main.go"]) {
    if (files.includes(candidate)) entrypoints.push(candidate);
  }

  const projectTopLevels = [
    ...new Set(
      files
        .filter((file) => file.includes("/"))
        .map((file) => `${file.split("/")[0]}/`),
    ),
  ].sort();
  const testFiles = files.filter((file) =>
    /(^|\/)(__tests__|test|tests)\/|\.(spec|test)\.[^.]+$/i.test(file),
  );
  const allNodeDependencies = {
    ...objectRecord(packageJson?.dependencies),
    ...objectRecord(packageJson?.devDependencies),
  };
  const packageManager = files.includes("pnpm-lock.yaml")
    ? "pnpm"
    : files.includes("yarn.lock")
      ? "yarn"
      : files.includes("bun.lock") || files.includes("bun.lockb")
        ? "bun"
        : "npm";
  const packageScripts = objectRecord(packageJson?.scripts);
  const packageTestScript =
    typeof packageScripts.test === "string" ? packageScripts.test : "";
  const focusedScriptNames = ["lint", "typecheck", "check", "test"].filter(
    (name) => typeof packageScripts[name] === "string",
  );
  const completeScriptNames = ["lint", "typecheck", "check", "test", "build"].filter(
    (name) => typeof packageScripts[name] === "string",
  );
  const pythonUsesPytest = Boolean(
    tomlSection(pyproject, "tool.pytest.ini_options") || /(^|\W)pytest(\W|$)/i.test(pyproject ?? ""),
  );
  const focusedCommands = focusedScriptNames.map((name) =>
    packageScriptCommand(packageManager, name),
  );
  const completeCommands = completeScriptNames.map((name) =>
    packageScriptCommand(packageManager, name),
  );
  if (pythonUsesPytest) {
    focusedCommands.push("python -m pytest");
    completeCommands.push("python -m pytest");
  }
  if (cargo) {
    focusedCommands.push("cargo check");
    completeCommands.push("cargo test");
  }
  if (files.includes("go.mod")) {
    focusedCommands.push("go test ./...");
    completeCommands.push("go test ./...");
  }

  let testFramework = null;
  if (packageTestScript.includes("node --test")) testFramework = "`node:test`";
  else if (Object.hasOwn(allNodeDependencies, "vitest")) testFramework = "`Vitest`";
  else if (Object.hasOwn(allNodeDependencies, "jest")) testFramework = "`Jest`";
  else if (Object.hasOwn(allNodeDependencies, "mocha")) testFramework = "`Mocha`";
  else if (pythonUsesPytest) testFramework = "`pytest`";
  else if (cargo) testFramework = "`cargo test`";
  else if (files.includes("go.mod")) testFramework = "`go test`";

  const testLocations = [
    ...new Set(testFiles.map((file) => `${file.split("/")[0]}/`)),
  ];
  const documentationLocations = [];
  if (files.includes("README.md")) documentationLocations.push("README.md");
  for (const directory of ["docs", "doc", "adr", "adrs"]) {
    if (files.some((file) => file.startsWith(`${directory}/`))) {
      documentationLocations.push(`${directory}/`);
    }
  }
  for (const file of ["CONTRIBUTING.md", "CHANGELOG.md"]) {
    if (files.includes(file)) documentationLocations.push(file);
  }

  return {
    ecosystem,
    purpose,
    purposeSource:
      typeof packageJson?.description === "string" && packageJson.description.trim()
        ? "package.json"
        : manifestPurpose
          ? pyproject
            ? "pyproject.toml"
            : "Cargo.toml"
          : readmePurpose
            ? "README.md"
            : null,
    architecture: projectTopLevels.length
      ? `componentes detectados en ${quotePaths(projectTopLevels)}.`
      : pendingField("módulos y relaciones relevantes"),
    entrypoints: entrypoints.length
      ? [...new Set(entrypoints)]
          .map((entrypoint) => {
            const [command, target] = entrypoint.split(" → ");
            return target ? `\`${command}\` → \`${target}\`` : `\`${entrypoint}\``;
          })
          .join(", ")
      : pendingField("interfaces o rutas de entrada"),
    focusedValidation: describeCommands(
      focusedCommands,
      profile?.focusedValidation ?? pendingField("comando o procedimiento de validación focalizada"),
    ),
    completeValidation: describeCommands(
      completeCommands,
      profile?.completeValidation ?? pendingField("comando o procedimiento de validación completa"),
    ),
    testFramework:
      testFramework ?? profile?.testFramework ?? pendingField("framework de tests o No aplica"),
    testLocation: testLocations.length
      ? quotePaths(testLocations)
      : (profile?.testLocation ?? pendingField("rutas de tests o No aplica")),
    documentation: documentationLocations.length
      ? quotePaths(documentationLocations)
      : (profile ? RECOMMENDED_DOCUMENTATION : null),
  };
}

function normalizeLabel(label) {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const FIELD_ALIASES = new Map([
  ["proposito", "purpose"],
  ["arquitectura", "architecture"],
  ["entrypoints", "entrypoints"],
  ["focalizada", "focusedValidation"],
  ["completa", "completeValidation"],
  ["framework", "testFramework"],
  ["ubicacion", "testLocation"],
  ["ciclo de vida", "testLifecycle"],
  ["rama", "gitStrategy"],
  ["estrategia permitida", "gitStrategy"],
  ["rama o estrategia permitida", "gitStrategy"],
  ["secretos", "secrets"],
  ["rutas protegidas", "protectedPaths"],
  ["datos inmutables", "immutableData"],
  ["acciones restringidas", "restrictedActions"],
  ["contaminacion de origen", "originContamination"],
  ["readme y documentacion tecnica", "documentation"],
  ["adrs", "adrs"],
]);
const REQUIRED_CONTRACT_FIELDS = [
  "purpose",
  "architecture",
  "entrypoints",
  "focusedValidation",
  "completeValidation",
  "testFramework",
  "testLocation",
  "testLifecycle",
  "gitStrategy",
  "secrets",
  "protectedPaths",
  "immutableData",
  "restrictedActions",
  "originContamination",
  "documentation",
  "adrs",
];
const CONTRACT_FIELD_LABELS = new Map([
  ["purpose", "Propósito"],
  ["architecture", "Arquitectura"],
  ["entrypoints", "Entrypoints"],
  ["focusedValidation", "Focalizada"],
  ["completeValidation", "Completa"],
  ["testFramework", "Framework"],
  ["testLocation", "Ubicación"],
  ["testLifecycle", "Ciclo de vida"],
  ["gitStrategy", "Rama o estrategia permitida"],
  ["secrets", "Secretos"],
  ["protectedPaths", "Rutas protegidas"],
  ["immutableData", "Datos inmutables"],
  ["restrictedActions", "Acciones restringidas"],
  ["originContamination", "Contaminación de origen"],
  ["documentation", "README y documentación técnica"],
  ["adrs", "ADRs"],
]);
const CONTRACT_FIELD_IDS = new Set(REQUIRED_CONTRACT_FIELDS);
const CONTRACT_FIELD_MARKER_PATTERN = /^<!-- agentic-contract-field ([A-Za-z][A-Za-z0-9]*) -->$/;
const PREVIOUS_CONTRACT_FIELD_MARKER_PATTERN =
  /^<!-- agentic-contract-field:[^\s]+ ([A-Za-z][A-Za-z0-9]*) -->$/;
const CONTRACT_FIELD_MARKER_LIKE = /<!--\s*agentic-contract-field\b/i;
const ADDITIONAL_RULES_HEADING = "## Reglas adicionales del proyecto";

function isMissingContractValue(value) {
  const normalized = value.trim();
  return (
    !normalized ||
    /^<(?:pendiente:\s*[^<>]+|módulos relevantes)>$/i.test(normalized) ||
    /^(todo|pendiente|por definir|tbd)(?:\b|\s|\.)/i.test(normalized)
  );
}

function isSafeContractFact(value) {
  return Boolean(
    value &&
      !/[\r\n]/.test(value) &&
      !value.includes(CONTRACT_START) &&
      !value.includes(CONTRACT_END),
  );
}

function unmappableContractError(entries) {
  const details = entries.flatMap((entry, index) => [
    `${index + 1}. ${entry.lines[0].trim()}`,
    ...entry.lines.slice(1).map((line) => `   ${line}`),
  ]);
  const error = new Error(
    [
      `AGENTS.md contiene ${entries.length} ${entries.length === 1 ? "entrada contractual no mapeable" : "entradas contractuales no mapeables"}:`,
      ...details,
      "Alternativas: ejecutar `agentic update` en una terminal interactiva para mapear cada entrada a un campo canónico, conservarla como regla adicional fuera del contrato, eliminarla con confirmación explícita o cancelar.",
      "La ejecución no interactiva no decide automáticamente y no escribió ningún archivo.",
    ].join("\n"),
  );
  error.exitCode = 2;
  return error;
}

function parseContract(source) {
  const start = source.indexOf(CONTRACT_START);
  const end = source.indexOf(CONTRACT_END);
  if (start < 0 || end < start) return { fields: new Map(), unmappable: [] };
  const block = source.slice(start + CONTRACT_START.length, end);
  const lines = block.split(/\r?\n/);
  const fields = new Map();
  const unmappable = [];
  const seenKeys = new Set();
  let activeKey = null;
  let pendingId = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      activeKey = null;
      continue;
    }
    const marker =
      line.trim().match(CONTRACT_FIELD_MARKER_PATTERN) ??
      line.trim().match(PREVIOUS_CONTRACT_FIELD_MARKER_PATTERN);
    if (!marker && CONTRACT_FIELD_MARKER_LIKE.test(line.trim())) {
      const error = new Error(
        `AGENTS.md contiene un marcador contractual con formato o sintaxis desconocida: ${line.trim()}.`,
      );
      error.exitCode = 2;
      throw error;
    }
    if (marker) {
      if (pendingId || !CONTRACT_FIELD_IDS.has(marker[1]) || seenKeys.has(marker[1])) {
        const error = new Error(
          `AGENTS.md contiene un ID contractual ambiguo o desconocido: ${marker[1]}.`,
        );
        error.exitCode = 2;
        throw error;
      }
      pendingId = marker[1];
      activeKey = null;
      continue;
    }
    const bullet = line.match(/^[-*+]\s+([^:]+):\s*(.*)$/);
    if (bullet) {
      const aliasKey = FIELD_ALIASES.get(normalizeLabel(bullet[1])) ?? null;
      activeKey = pendingId ?? aliasKey;
      if (!activeKey) {
        const entryLines = [line];
        while (index + 1 < lines.length && /^\s{2,}\S/.test(lines[index + 1])) {
          entryLines.push(lines[index + 1]);
          index += 1;
        }
        unmappable.push({
          label: bullet[1].trim(),
          lines: entryLines,
          value: [bullet[2].trim(), ...entryLines.slice(1).map((item) => item.trim())]
            .filter(Boolean)
            .join(" "),
        });
        activeKey = null;
        continue;
      }
      if (pendingId && aliasKey && aliasKey !== pendingId) {
        const error = new Error(
          `AGENTS.md contradice el ID contractual ${pendingId} con la etiqueta ${bullet[1].trim()}.`,
        );
        error.exitCode = 2;
        throw error;
      }
      if (seenKeys.has(activeKey)) {
        const error = new Error(`AGENTS.md duplica el campo contractual ${bullet[1].trim()}.`);
        error.exitCode = 2;
        throw error;
      }
      pendingId = null;
      seenKeys.add(activeKey);
      if (activeKey && !isMissingContractValue(bullet[2])) {
        fields.set(activeKey, bullet[2].trim());
      }
      continue;
    }
    if (line === GOLDEN_RULE_DEVELOPMENT_BULLET) {
      activeKey = null;
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const entryLines = [line];
      while (index + 1 < lines.length && /^\s{2,}\S/.test(lines[index + 1])) {
        entryLines.push(lines[index + 1]);
        index += 1;
      }
      const value = [
        line.replace(/^[-*+]\s+/, "").trim(),
        ...entryLines.slice(1).map((item) => item.trim()),
      ]
        .filter(Boolean)
        .join(" ");
      unmappable.push({ label: value, lines: entryLines, value });
      activeKey = null;
      pendingId = null;
      continue;
    }
    if (activeKey && /^\s{2,}\S/.test(line)) {
      const previous = fields.get(activeKey);
      if (previous) fields.set(activeKey, `${previous} ${line.trim()}`);
    } else if (line.trim()) {
      activeKey = null;
    }
  }

  if (pendingId) {
    const error = new Error(`AGENTS.md deja el ID contractual ${pendingId} sin campo asociado.`);
    error.exitCode = 2;
    throw error;
  }

  return { fields, unmappable };
}

function parseContractFields(source) {
  const parsed = parseContract(source);
  if (parsed.unmappable.length) throw unmappableContractError(parsed.unmappable);
  return parsed.fields;
}

function contractValue(existingFields, key, fallback) {
  return existingFields.get(key) ?? fallback;
}

// Campos del contrato que quedaron sin valor real, con la sección y la etiqueta
// exactas que exige informar la regla STRICT_PROJECT_CONTRACT_RULE.
function contractGaps(contractText) {
  const gaps = [];
  let section = "Proyecto";

  for (const line of contractText.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    const bullet = line.match(/^-\s+([^:]+):\s*(.*)$/);
    if (!bullet) continue;
    const label = bullet[1].trim();
    if (FIELD_ALIASES.has(normalizeLabel(label)) && isMissingContractValue(bullet[2])) {
      gaps.push({ section, label });
    }
  }

  return gaps;
}

function renderContract(project, existingFields = new Map()) {
  const gitStrategy = contractValue(
    existingFields,
    "gitStrategy",
    project.gitStrategy,
  );

  return `${CONTRACT_START}
${GENERATED_CONTRACT_MARKER}

${GOLDEN_RULE_DEVELOPMENT}

## Proyecto

<!-- agentic-contract-field purpose -->
- Propósito: ${contractValue(existingFields, "purpose", project.purpose)}
<!-- agentic-contract-field architecture -->
- Arquitectura: ${contractValue(existingFields, "architecture", project.architecture)}
<!-- agentic-contract-field entrypoints -->
- Entrypoints: ${contractValue(existingFields, "entrypoints", project.entrypoints)}

## Validación

<!-- agentic-contract-field focusedValidation -->
- Focalizada: ${contractValue(existingFields, "focusedValidation", project.focusedValidation)}
<!-- agentic-contract-field completeValidation -->
- Completa: ${contractValue(existingFields, "completeValidation", project.completeValidation)}

## Tests

<!-- agentic-contract-field testFramework -->
- Framework: ${contractValue(existingFields, "testFramework", project.testFramework)}
<!-- agentic-contract-field testLocation -->
- Ubicación: ${contractValue(existingFields, "testLocation", project.testLocation)}
<!-- agentic-contract-field testLifecycle -->
- Ciclo de vida: ${contractValue(existingFields, "testLifecycle", "conservar tests de regresión y retirar solo pruebas explícitamente temporales.")}

## Git

<!-- agentic-contract-field gitStrategy -->
- Rama o estrategia permitida: ${gitStrategy}

## Seguridad

<!-- agentic-contract-field secrets -->
- Secretos: ${contractValue(existingFields, "secrets", "no almacenar credenciales; usar mecanismos externos o variables de entorno.")}
<!-- agentic-contract-field protectedPaths -->
- Rutas protegidas: ${contractValue(existingFields, "protectedPaths", "`.git/`, `.codegraph/`, `.engram/` y archivos de secretos.")}
<!-- agentic-contract-field immutableData -->
- Datos inmutables: ${contractValue(existingFields, "immutableData", "No aplica.")}
<!-- agentic-contract-field restrictedActions -->
- Acciones restringidas: ${contractValue(existingFields, "restrictedActions", "no instalar herramientas, acceder a remotos, publicar paquetes ni modificar Git sin autorización explícita.")}
<!-- agentic-contract-field originContamination -->
- Contaminación de origen: ${contractValue(existingFields, "originContamination", "No aplica; esta adopción parte de la plantilla canónica y no de una extracción manual de otro repositorio.")}

## Documentación

<!-- agentic-contract-field documentation -->
- README y documentación técnica: ${contractValue(
    existingFields,
    "documentation",
    project.documentation
      ? `${project.documentation}; actualizar cuando cambien uso, arquitectura o validación.`
      : pendingField("ubicaciones de documentación y criterio de actualización"),
  )}
<!-- agentic-contract-field adrs -->
- ADRs: ${contractValue(existingFields, "adrs", "No aplica mientras el proyecto no declare una ubicación.")}

${CONTRACT_END}`;
}

function inspectContract(source, pathLabel) {
  const starts = [...source.matchAll(new RegExp(CONTRACT_START, "g"))];
  const ends = [...source.matchAll(new RegExp(CONTRACT_END, "g"))];
  if (starts.length === 0 && ends.length === 0) {
    return { present: false, text: null };
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index < starts[0].index) {
    const error = new Error(
      `${pathLabel} contiene marcadores contractuales incompletos o duplicados; no se modificará.`,
    );
    error.exitCode = 2;
    throw error;
  }
  return {
    present: true,
    text: source.slice(starts[0].index, ends[0].index + CONTRACT_END.length),
  };
}

// `init` no interroga por hechos del contrato: escribe lo que infiere y deja un
// marcador explícito en lo que no. `--purpose` y `--git-strategy` son un atajo
// para declararlos de una vez, nunca un requisito de la adopción.
function resolveContractFacts({
  options,
  project,
  existingFields,
  baselineContract,
  templatePurpose,
}) {
  const hasGit = existsSync(join(options.destination, ".git"));
  if (options.purpose) existingFields.set("purpose", options.purpose);
  if (options.gitStrategy) existingFields.set("gitStrategy", options.gitStrategy);

  let purpose = existingFields.get("purpose") ?? project.purpose;
  if (purpose && !isSafeContractFact(purpose)) purpose = null;
  // Una copia de la plantilla arrastra su propio README: el propósito de la
  // capa no puede heredarse como si fuera el del proyecto adoptante.
  if (
    baselineContract &&
    !options.purpose &&
    project.purposeSource === "README.md" &&
    templatePurpose &&
    normalizeLabel(purpose ?? "") === normalizeLabel(templatePurpose)
  ) {
    purpose = null;
  }

  let gitStrategy = existingFields.get("gitStrategy");
  if (gitStrategy && !isSafeContractFact(gitStrategy)) gitStrategy = null;
  if (!gitStrategy && !hasGit) {
    gitStrategy =
      "No aplica mientras el propietario no inicialice Git; el inicializador no lo crea ni lo modifica.";
  }

  // Un hecho descartado no puede quedar en el mapa: el fallback pendiente de
  // `renderContract` es lo que la regla estricta cobra después.
  if (purpose) existingFields.set("purpose", purpose);
  else existingFields.delete("purpose");
  if (gitStrategy) existingFields.set("gitStrategy", gitStrategy);
  else existingFields.delete("gitStrategy");

  project.purpose = purpose ?? pendingField("qué hace el proyecto, en una frase");
  project.gitStrategy = gitStrategy ?? pendingField("rama o estrategia Git permitida");
}

function replaceContract(source, contract) {
  const start = source.indexOf(CONTRACT_START);
  const end = source.indexOf(CONTRACT_END);
  if (start < 0 || end < start) {
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const separator = source.length === 0 ? "" : source.endsWith(eol) ? eol : `${eol}${eol}`;
    return `${source}${separator}${contract.replaceAll("\n", eol)}${eol}`;
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return `${source.slice(0, start)}${contract.replaceAll("\n", eol)}${source.slice(end + CONTRACT_END.length)}`;
}

function appendAdditionalProjectRules(source, entries) {
  if (!entries.length) return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const blocks = entries.map((entry) => entry.lines.join(eol));
  const contractStart = source.indexOf(CONTRACT_START);
  const contractEnd = source.indexOf(CONTRACT_END);
  const headings = [...source.matchAll(/^## Reglas adicionales del proyecto[ \t]*\r?$/gm)];
  const heading = headings.find(
    (match) => match.index < contractStart || match.index > contractEnd,
  );

  if (!heading) {
    const separator = source.length === 0
      ? ""
      : source.endsWith(`${eol}${eol}`)
        ? ""
        : source.endsWith(eol)
          ? eol
          : `${eol}${eol}`;
    return `${source}${separator}${ADDITIONAL_RULES_HEADING}${eol}${eol}${blocks.join(`${eol}${eol}`)}${eol}`;
  }

  const contentStart = heading.index + heading[0].length;
  const nextHeading = /^##\s+/gm;
  nextHeading.lastIndex = contentStart;
  const followingHeading = nextHeading.exec(source);
  const boundaries = [followingHeading?.index, contractStart > contentStart ? contractStart : null]
    .filter((value) => Number.isInteger(value));
  const contentEnd = boundaries.length ? Math.min(...boundaries) : source.length;
  const section = source.slice(contentStart, contentEnd).replace(/\r\n/g, "\n");
  const additions = blocks.filter(
    (block) => !section.includes(block.replace(/\r\n/g, "\n")),
  );
  if (!additions.length) return source;

  const prefix = source.slice(0, contentEnd);
  const suffix = source.slice(contentEnd);
  const before = prefix.endsWith(`${eol}${eol}`)
    ? ""
    : prefix.endsWith(eol)
      ? eol
      : `${eol}${eol}`;
  const after = suffix ? `${eol}${eol}` : eol;
  return `${prefix}${before}${additions.join(`${eol}${eol}`)}${after}${suffix}`;
}

async function planTemplateFiles(destination, force) {
  const actions = [];
  const collisions = [];

  for (const relativePath of TEMPLATE_FILES) {
    const sourcePath = templateSourcePath(relativePath);
    const destinationPath = join(destination, ...relativePath.split("/"));
    const sourceState = await pathState(sourcePath);
    if (!sourceState?.isFile() || sourceState.isSymbolicLink()) {
      throw new Error(`La distribución de origen no contiene un archivo regular: ${relativePath}`);
    }
    const unsafeParent = await unsafeDestinationParent(destination, relativePath);
    if (unsafeParent) {
      collisions.push(`${relativePath} (ancestro no seguro: ${unsafeParent})`);
      continue;
    }
    const destinationState = await pathState(destinationPath);
    if (!destinationState) {
      actions.push({
        type: "copy",
        relativePath,
        sourcePath,
        destinationPath,
        sourceState,
        sourceContent: await readFile(sourcePath),
      });
      continue;
    }
    if (!destinationState.isFile() || destinationState.isSymbolicLink()) {
      collisions.push(relativePath);
      continue;
    }
    const [sourceContent, destinationContent] = await Promise.all([
      readFile(sourcePath),
      readFile(destinationPath),
    ]);
    if (sourceContent.equals(destinationContent)) {
      actions.push({
        type: "validate",
        relativePath,
        sourcePath,
        destinationPath,
        sourceState,
        destinationState,
        plannedContent: destinationContent,
        sourceContent,
      });
    } else if (force) {
      actions.push({
        type: "overwrite",
        relativePath,
        sourcePath,
        destinationPath,
        sourceState,
        destinationState,
        replacedContent: destinationContent,
        sourceContent,
      });
    } else {
      collisions.push(relativePath);
    }
  }

  return { actions, collisions };
}

async function detectInstalledLayer(destination) {
  const markers = [];
  for (const marker of LAYER_MARKERS) {
    const state = await pathState(join(destination, ...marker.split("/")));
    if (state?.isFile() && !state.isSymbolicLink()) markers.push(marker);
  }

  let version = null;
  let invalidVersion = null;
  const versionPath = join(destination, ...LAYER_VERSION_FILE.split("/"));
  const versionState = await pathState(versionPath);
  if (versionState?.isFile() && !versionState.isSymbolicLink()) {
    const declared = withoutByteOrderMark(await readFile(versionPath, "utf8")).trim();
    if (parseSemVer(declared)) version = declared;
    else invalidVersion = declared || "<vacía>";
  }

  return { present: markers.length > 0 || Boolean(versionState), markers, version, invalidVersion };
}

function classifyInstalledLayer(layer, distributionVersion) {
  if (!layer.version) return "sin-version";
  const comparison = compareSemVer(layer.version, distributionVersion);
  if (comparison < 0) return "anterior";
  if (comparison > 0) return "posterior";
  return "igual";
}

// Residuos de otra versión de la capa: archivos dentro de los directorios que
// la distribución gestiona por completo y que ya no le pertenecen.
async function planOrphanFiles(destination) {
  const canonical = new Set(TEMPLATE_FILES);
  const orphans = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const relativePath = relative(destination, absolutePath).replaceAll("\\", "/");
        const error = new Error(
          `El directorio administrado contiene un enlace simbólico no seguro: ${relativePath}.`,
        );
        error.exitCode = 2;
        throw error;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = relative(destination, absolutePath).replaceAll("\\", "/");
        if (!canonical.has(relativePath)) {
          const previousState = await lstat(absolutePath);
          orphans.push({
            relativePath,
            absolutePath,
            previousContent: await readFile(absolutePath),
            previousMode: previousState.mode,
            previousState,
          });
        }
      }
    }
  }

  for (const managed of MANAGED_DIRECTORIES) {
    const base = join(destination, ...managed.split("/"));
    const state = await pathState(base);
    if (state?.isSymbolicLink()) {
      const error = new Error(`El directorio administrado es un enlace simbólico no seguro: ${managed}.`);
      error.exitCode = 2;
      throw error;
    }
    if (!state?.isDirectory()) continue;
    await visit(base);
  }

  return orphans.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

// `rmdir` falla si el directorio no está vacío; esa es justamente la garantía
// que se quiere: nunca se borra contenido que no se haya listado antes.
async function removeEmptyManagedDirectories(destination) {
  const directories = [];

  async function collect(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const absolutePath = join(directory, entry.name);
        directories.push(absolutePath);
        await collect(absolutePath);
      }
    }
  }

  for (const managed of MANAGED_DIRECTORIES) {
    const base = join(destination, ...managed.split("/"));
    const state = await pathState(base);
    if (!state?.isDirectory() || state.isSymbolicLink()) continue;
    await collect(base);
  }

  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(directory);
    } catch {
      // Conserva todo directorio que aún tenga contenido del proyecto.
    }
  }
}

function describeInstalledLayer(layer, distributionVersion) {
  if (layer.version && layer.version !== distributionVersion) {
    return `capa agéntica ${layer.version} instalada; la distribución actual es ${distributionVersion}`;
  }
  if (layer.version) return `capa agéntica ${layer.version} instalada`;
  return "capa agéntica instalada sin marca de versión";
}

function isInteractiveTerminal() {
  return Boolean(
    (input.isTTY && output.isTTY) || process.env.AGENTIC_INIT_TEST_FORCE_TTY === "1",
  );
}

async function confirmLayerReplacement(layer, collisions, distributionVersion) {
  const readline = createInterface({ input, output });
  try {
    output.write(`\nSe detectó una ${describeInstalledLayer(layer, distributionVersion)}.\n`);
    output.write(
      collisions.length === 1
        ? "Difiere 1 archivo canónico:\n"
        : `Difieren ${collisions.length} archivos canónicos:\n`,
    );
    for (const path of collisions.slice(0, 10)) output.write(`- ${path}\n`);
    if (collisions.length > 10) output.write(`- … y ${collisions.length - 10} más.\n`);
    output.write(
      "Reemplazar sobrescribe los archivos canónicos y elimina residuos de otras\nversiones. No toca AGENTS.md fuera del contrato ni las DevSessions.\n",
    );
    const answer = (await readline.question("¿[r]eemplazar la capa o [c]ancelar? [r/C]: ")).trim();
    return /^(r|reemplazar|replace)$/i.test(answer) ? "replace" : "cancel";
  } finally {
    readline.close();
  }
}

const ACTION_LABELS = {
  copy: "copiar",
  overwrite: "sobrescribir",
  validate: "validar",
  create: "crear",
  update: "actualizar",
};

async function confirmApplication(actions, agentsAction, orphans, versionAction) {
  const writes =
    actions.some((action) => action.type !== "validate") ||
    agentsAction !== "validate" ||
    versionAction !== "validate" ||
    orphans.length > 0;
  if (!writes) return true;
  const readline = createInterface({ input, output });
  try {
    const answer = (await readline.question("\n¿Aplicar estas acciones? [s/N]: ")).trim();
    return /^(s|si|sí|y|yes)$/i.test(answer);
  } finally {
    readline.close();
  }
}

async function resolveUnmappableContractEntries(entries, existingFields) {
  const additionalRules = [];
  const readline = createInterface({ input, output });
  try {
    output.write(
      `\nSe encontraron ${entries.length} ${entries.length === 1 ? "entrada contractual no mapeable" : "entradas contractuales no mapeables"}.\n`,
    );
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      let resolved = false;
      while (!resolved) {
        output.write(`\nEntrada ${entryIndex + 1} de ${entries.length}:\n${entry.lines.join("\n")}\n`);
        output.write("1. Mapear a un campo contractual existente.\n");
        output.write("2. Conservar como regla adicional fuera del contrato.\n");
        output.write("3. Eliminar.\n");
        output.write("4. Cancelar la actualización.\n");
        const decision = (await readline.question("Decisión [1-4]: ")).trim();

        if (decision === "1") {
          output.write("\nCampos contractuales canónicos:\n");
          REQUIRED_CONTRACT_FIELDS.forEach((field, index) => {
            output.write(
              `${index + 1}. ${CONTRACT_FIELD_LABELS.get(field)} [${field}] — ${
                existingFields.has(field) ? "ocupado" : "disponible"
              }\n`,
            );
          });
          const selected = Number(await readline.question(`Campo [1-${REQUIRED_CONTRACT_FIELDS.length}]: `));
          const field = REQUIRED_CONTRACT_FIELDS[selected - 1];
          if (!field) {
            output.write("Selección inválida; vuelva a decidir qué hacer con la entrada.\n");
            continue;
          }
          if (existingFields.has(field)) {
            output.write(
              `Conflicto: ${CONTRACT_FIELD_LABELS.get(field)} [${field}] ya tiene valor; no se sobrescribió ni fusionó.\n`,
            );
            continue;
          }
          existingFields.set(field, entry.value);
          resolved = true;
          continue;
        }
        if (decision === "2") {
          additionalRules.push(entry);
          resolved = true;
          continue;
        }
        if (decision === "3") {
          const confirmation = (
            await readline.question(
              "Esta acción elimina información. Escriba ELIMINAR para confirmarla: ",
            )
          ).trim();
          if (confirmation === "ELIMINAR") {
            resolved = true;
          } else {
            output.write("Eliminación no confirmada; la entrada sigue intacta en el plan.\n");
          }
          continue;
        }
        if (decision === "4") {
          const error = new Error("Cancelado por el usuario; no se escribió ningún archivo.");
          error.exitCode = 3;
          throw error;
        }
        output.write("Selección inválida; elija una opción entre 1 y 4.\n");
      }
    }
  } finally {
    readline.close();
  }
  return additionalRules;
}

async function revalidateLayerPlan({
  destination,
  templateActions,
  destinationAgentsPath,
  destinationAgentsState,
  currentAgents,
  orphans,
  versionPath,
  versionState,
  currentVersionContent,
}) {
  await assertSafeDestinationAncestors(destination);
  if (destinationAgentsState) {
    await assertExpectedRegularFile(
      destinationAgentsPath,
      currentAgents,
      destinationAgentsState,
      "AGENTS.md",
    );
  } else await assertAbsentFile(destinationAgentsPath, "AGENTS.md");

  for (const action of templateActions) {
    const unsafeParent = await unsafeDestinationParent(destination, action.relativePath);
    if (unsafeParent) {
      throw new Error(
        `${action.relativePath} tiene un ancestro no seguro después del plan: ${unsafeParent}.`,
      );
    }
    await assertExpectedRegularFile(
      action.sourcePath,
      action.sourceContent,
      action.sourceState,
      `${action.relativePath} en la distribución`,
    );
    if (action.type === "copy") {
      await assertAbsentFile(action.destinationPath, action.relativePath);
      continue;
    }
    const expected = action.type === "overwrite" ? action.replacedContent : action.plannedContent;
    await assertExpectedRegularFile(
      action.destinationPath,
      expected,
      action.destinationState,
      action.relativePath,
    );
  }

  for (const orphan of orphans) {
    const unsafeParent = await unsafeDestinationParent(destination, orphan.relativePath);
    if (unsafeParent) {
      throw new Error(
        `${orphan.relativePath} cambió después del plan; no se escribió ningún archivo.`,
      );
    }
    await assertExpectedRegularFile(
      orphan.absolutePath,
      orphan.previousContent,
      orphan.previousState,
      orphan.relativePath,
    );
  }

  if (versionState) {
    await assertExpectedRegularFile(
      versionPath,
      currentVersionContent,
      versionState,
      LAYER_VERSION_FILE,
    );
  } else await assertAbsentFile(versionPath, LAYER_VERSION_FILE);
}

async function applyLayerTransaction({
  options,
  templateActions,
  agentsAction,
  destinationAgentsPath,
  destinationAgentsState,
  currentAgents,
  nextAgents,
  orphans,
  versionAction,
  versionPath,
  versionState,
  currentVersionContent,
  versionContent,
}) {
  const mutations = [];
  const createdDirectories = new Set();
  let mutationCount = 0;
  let backupRoot = null;
  const backupManifest = [];
  let raceInjected = false;
  let rollbackRaceInjected = false;
  const injectedFailureAfter = Number(process.env.AGENTIC_INIT_TEST_FAIL_AFTER ?? 0);
  const injectedRollbackFailureAfter = Number(
    process.env.AGENTIC_INIT_TEST_FAIL_ROLLBACK_AFTER ?? 0,
  );

  async function persistBackupManifest() {
    await writeFile(
      join(backupRoot, "manifest.json"),
      `${JSON.stringify(backupManifest, null, 2)}\n`,
      "utf8",
    );
  }

  async function stageBackup(filePath, previousContent, previousMode) {
    if (!backupRoot) backupRoot = await mkdtemp(join(tmpdir(), "agentic-layer-backup-"));
    const backup = previousContent === null
      ? null
      : `${String(backupManifest.length + 1).padStart(4, "0")}.bin`;
    if (backup) await writeFile(join(backupRoot, backup), previousContent, { flag: "wx" });
    const entry = {
      target: filePath,
      backup,
      mode: previousMode,
      previousExists: previousContent !== null,
      status: "staged",
    };
    backupManifest.push(entry);
    await persistBackupManifest();
    return entry;
  }

  async function injectConfiguredRace(relativePath, filePath) {
    if (
      raceInjected ||
      process.env.AGENTIC_INIT_TEST_RACE_PATH !== relativePath ||
      !process.env.AGENTIC_INIT_TEST_RACE_ACTION
    ) {
      return;
    }
    raceInjected = true;
    await mkdir(dirname(filePath), { recursive: true });
    const content =
      process.env.AGENTIC_INIT_TEST_RACE_ACTION === "appear"
        ? "contenido aparecido durante la aplicación\n"
        : "contenido sustituido durante la aplicación\n";
    await writeFile(filePath, content, "utf8");
  }

  async function injectConfiguredRollbackRace(mutation) {
    if (
      rollbackRaceInjected ||
      process.env.AGENTIC_INIT_TEST_ROLLBACK_RACE_PATH !== mutation.relativePath ||
      !process.env.AGENTIC_INIT_TEST_ROLLBACK_RACE_TARGET
    ) {
      return;
    }
    rollbackRaceInjected = true;
    const parent = dirname(mutation.filePath);
    const external = resolve(process.env.AGENTIC_INIT_TEST_ROLLBACK_RACE_TARGET);
    const externalState = await pathState(external);
    if (!externalState?.isDirectory() || externalState.isSymbolicLink()) {
      throw new Error("el destino de la carrera de rollback no es un directorio real");
    }
    const originalParent = `${parent}.agentic-rollback-original-${process.pid}`;
    await rename(parent, originalParent);
    await symlink(external, parent, process.platform === "win32" ? "junction" : "dir");
  }

  async function ensureParent(filePath) {
    const parent = dirname(filePath);
    const segments = relative(options.destination, parent).split(/[\\/]/).filter(Boolean);
    let current = options.destination;
    for (const segment of segments) {
      current = join(current, segment);
      let state = await pathState(current);
      if (!state) {
        try {
          await mkdir(current);
          createdDirectories.add(current);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        state = await pathState(current);
      }
      if (!state?.isDirectory() || state.isSymbolicLink()) {
        throw changedAfterPlan(
          `${relative(options.destination, current).replaceAll("\\", "/")} es un ancestro no seguro después del plan.`,
        );
      }
    }
  }

  async function assertSafeMutationParent(relativePath) {
    try {
      await assertSafeDestinationAncestors(options.destination);
    } catch (error) {
      throw changedAfterPlan(`${relativePath} tiene un ancestro no seguro: ${error.message}`);
    }
    const unsafeParent = await unsafeDestinationParent(options.destination, relativePath);
    if (unsafeParent) {
      throw changedAfterPlan(
        `${relativePath} tiene un ancestro no seguro después del plan: ${unsafeParent}.`,
      );
    }
  }

  async function mutate({
    filePath,
    relativePath,
    previousContent,
    previousMode,
    previousState,
    nextContent,
    operation,
  }) {
    const backup = await stageBackup(filePath, previousContent, previousMode);
    const appliedState = await operation();
    mutations.push({
      filePath,
      relativePath,
      previousContent,
      previousMode,
      previousState,
      appliedContent: operation.kind === "remove" ? null : nextContent,
      appliedState,
      backup,
    });
    backup.status = "confirmed";
    await persistBackupManifest();
    mutationCount += 1;
    if (
      options.operation === "update" &&
      Number.isInteger(injectedFailureAfter) &&
      injectedFailureAfter > 0 &&
      mutationCount === injectedFailureAfter
    ) {
      throw new Error(`fallo inyectado después de ${mutationCount} escrituras`);
    }
  }

  try {
    await mkdir(options.destination, { recursive: true });
    for (const action of templateActions) {
      if (action.type === "copy") {
        await ensureParent(action.destinationPath);
        await injectConfiguredRace(action.relativePath, action.destinationPath);
        const operation = async () => {
          await assertExpectedRegularFile(
            action.sourcePath,
            action.sourceContent,
            action.sourceState,
            `${action.relativePath} en la distribución`,
          );
          return atomicCreateNoFollow(
            action.destinationPath,
            action.sourceContent,
            action.sourceState.mode,
            action.relativePath,
            () => assertSafeMutationParent(action.relativePath),
          );
        };
        operation.kind = "create";
        await mutate({
          filePath: action.destinationPath,
          relativePath: action.relativePath,
          previousContent: null,
          previousMode: null,
          previousState: null,
          nextContent: action.sourceContent,
          operation,
        });
      } else if (action.type === "overwrite") {
        await injectConfiguredRace(action.relativePath, action.destinationPath);
        const operation = async () => {
          await assertExpectedRegularFile(
            action.sourcePath,
            action.sourceContent,
            action.sourceState,
            `${action.relativePath} en la distribución`,
          );
          return atomicReplaceNoFollow(
            action.destinationPath,
            action.replacedContent,
            action.destinationState,
            action.sourceContent,
            action.destinationState.mode,
            action.relativePath,
            () => assertSafeMutationParent(action.relativePath),
          );
        };
        operation.kind = "replace";
        await mutate({
          filePath: action.destinationPath,
          relativePath: action.relativePath,
          previousContent: action.replacedContent,
          previousMode: action.destinationState.mode,
          previousState: action.destinationState,
          nextContent: action.sourceContent,
          operation,
        });
      }
    }
    if (agentsAction !== "validate") {
      await ensureParent(destinationAgentsPath);
      await injectConfiguredRace("AGENTS.md", destinationAgentsPath);
      const operation = destinationAgentsState
        ? async () => {
            return atomicReplaceNoFollow(
              destinationAgentsPath,
              currentAgents,
              destinationAgentsState,
              nextAgents,
              destinationAgentsState.mode,
              "AGENTS.md",
              () => assertSafeMutationParent("AGENTS.md"),
            );
          }
        : async () => {
            return atomicCreateNoFollow(
              destinationAgentsPath,
              nextAgents,
              null,
              "AGENTS.md",
              () => assertSafeMutationParent("AGENTS.md"),
            );
          };
      operation.kind = destinationAgentsState ? "replace" : "create";
      await mutate({
        filePath: destinationAgentsPath,
        relativePath: "AGENTS.md",
        previousContent: destinationAgentsState ? Buffer.from(currentAgents, "utf8") : null,
        previousMode: destinationAgentsState?.mode ?? null,
        previousState: destinationAgentsState,
        nextContent: Buffer.from(nextAgents, "utf8"),
        operation,
      });
    }
    for (const orphan of orphans) {
      await injectConfiguredRace(orphan.relativePath, orphan.absolutePath);
      const operation = async () => {
        await assertSafeMutationParent(orphan.relativePath);
        await assertExpectedRegularFile(
          orphan.absolutePath,
          orphan.previousContent,
          orphan.previousState,
          orphan.relativePath,
        );
        await rm(orphan.absolutePath);
        return null;
      };
      operation.kind = "remove";
      await mutate({
        filePath: orphan.absolutePath,
        relativePath: orphan.relativePath,
        previousContent: orphan.previousContent,
        previousMode: orphan.previousMode,
        previousState: orphan.previousState,
        nextContent: null,
        operation,
      });
    }
    if (versionAction !== "validate") {
      await ensureParent(versionPath);
      await injectConfiguredRace(LAYER_VERSION_FILE, versionPath);
      const operation = versionState
        ? async () => {
            return atomicReplaceNoFollow(
              versionPath,
              currentVersionContent,
              versionState,
              versionContent,
              versionState.mode,
              LAYER_VERSION_FILE,
              () => assertSafeMutationParent(LAYER_VERSION_FILE),
            );
          }
        : async () => {
            return atomicCreateNoFollow(
              versionPath,
              versionContent,
              null,
              LAYER_VERSION_FILE,
              () => assertSafeMutationParent(LAYER_VERSION_FILE),
            );
          };
      operation.kind = versionState ? "replace" : "create";
      await mutate({
        filePath: versionPath,
        relativePath: LAYER_VERSION_FILE,
        previousContent: versionState ? Buffer.from(currentVersionContent, "utf8") : null,
        previousMode: versionState?.mode ?? null,
        previousState: versionState,
        nextContent: Buffer.from(versionContent, "utf8"),
        operation,
      });
    }
  } catch (cause) {
    const rollbackErrors = [];
    let rollbackCount = 0;
    for (const mutation of [...mutations].reverse()) {
      try {
        await injectConfiguredRollbackRace(mutation);
        rollbackCount += 1;
        if (injectedRollbackFailureAfter === rollbackCount) {
          throw new Error(`fallo inyectado durante la restauración ${rollbackCount}`);
        }
        if (mutation.previousContent === null) {
          await assertSafeMutationParent(mutation.relativePath);
          await assertExpectedRegularFile(
            mutation.filePath,
            mutation.appliedContent,
            mutation.appliedState,
            mutation.relativePath,
          );
          await rm(mutation.filePath, { force: true });
        } else if (mutation.appliedState) {
          await atomicReplaceNoFollow(
            mutation.filePath,
            mutation.appliedContent,
            mutation.appliedState,
            mutation.previousContent,
            mutation.previousMode,
            mutation.relativePath,
            () => assertSafeMutationParent(mutation.relativePath),
          );
        } else {
          await atomicCreateNoFollow(
            mutation.filePath,
            mutation.previousContent,
            mutation.previousMode,
            mutation.relativePath,
            () => assertSafeMutationParent(mutation.relativePath),
          );
        }
      } catch (error) {
        rollbackErrors.push(`${mutation.filePath}: ${error.message}`);
      }
    }
    for (const directory of [...createdDirectories].sort((left, right) => right.length - left.length)) {
      try {
        const relativeDirectory = relative(options.destination, directory).replaceAll("\\", "/");
        await assertSafeMutationParent(`${relativeDirectory}/.agentic-rollback-check`);
        const directoryState = await pathState(directory);
        if (!directoryState) continue;
        if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
          throw changedAfterPlan(`${relativeDirectory} cambió durante la restauración.`);
        }
        await rmdir(directory);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) {
          rollbackErrors.push(`${directory}: ${error.message}`);
        }
      }
    }
    for (const mutation of mutations) {
      try {
        await assertSafeMutationParent(mutation.relativePath);
        const restoredState = await pathState(mutation.filePath);
        if (mutation.previousContent === null) {
          if (restoredState) rollbackErrors.push(`${mutation.filePath}: debía quedar ausente`);
        } else {
          const restored =
            restoredState?.isFile() && !restoredState.isSymbolicLink()
              ? await readFile(mutation.filePath)
              : null;
          if (!restored?.equals(mutation.previousContent)) {
            rollbackErrors.push(`${mutation.filePath}: contenido no restaurado`);
          } else if (
            mutation.previousMode !== null &&
            (restoredState.mode & 0o777) !== (mutation.previousMode & 0o777)
          ) {
            rollbackErrors.push(`${mutation.filePath}: permisos no restaurados`);
          }
        }
      } catch (error) {
        rollbackErrors.push(`${mutation.filePath}: ${error.message}`);
      }
    }
    if (rollbackErrors.length) {
      if (backupRoot) await persistBackupManifest().catch(() => {});
      throw new Error(
        `Falló la actualización (${cause.message}) y la restauración quedó incompleta:\n${rollbackErrors
          .map((item) => `- ${item}`)
          .join("\n")}${
          backupRoot ? `\nRespaldos recuperables conservados en: ${backupRoot}` : ""
        }`,
      );
    }
    if (backupRoot) await rm(backupRoot, { recursive: true, force: true });
    if (mutations.length === 0 && cause.exitCode) throw cause;
    throw new Error(`Falló la actualización (${cause.message}); restauración verificada.`);
  }

  if (backupRoot) await rm(backupRoot, { recursive: true, force: true });

  return {
    copied: templateActions.filter((action) => action.type === "copy").length,
    overwritten: templateActions.filter((action) => action.type === "overwrite").length,
    removed: orphans.length,
  };
}

const CODEX_THREADS_KEY = "max_concurrent_threads_per_session";
const CODEX_THREADS_PREVIOUS_KEY = "max_threads";
const CODEX_SUBAGENT_CAPACITY = 12;

function hasTomlMultilineString(text) {
  let quote = null;
  let comment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (comment) {
      if (character === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "#") {
      comment = true;
      continue;
    }
    if (text.startsWith("'''", index) || text.startsWith('\"\"\"', index)) return true;
    if (character === '"' || character === "'") quote = character;
  }
  return false;
}

function parseCodexToml(source, pathLabel) {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  if (hasTomlMultilineString(text)) {
    return { ambiguous: `${pathLabel} contiene un string TOML multilínea; requiere edición manual.` };
  }
  let inAgents = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      const supportedHeader =
        /^\[[^\[\]\r\n]+\][ \t]*(?:#.*)?$/.test(trimmed) ||
        /^\[\[[^\[\]\r\n]+\]\][ \t]*(?:#.*)?$/.test(trimmed);
      if (!supportedHeader) {
        return { ambiguous: `${pathLabel} contiene una cabecera TOML no soportada.` };
      }
      if (/^\[agents\][ \t]*(?:#.*)?$/.test(trimmed)) {
        inAgents = true;
        continue;
      }
      if (/(?:^|[.\[\s"'])agents(?:$|[.\]\s"'])/.test(trimmed)) {
        return { ambiguous: `${pathLabel} contiene una definición agents no soportada.` };
      }
      inAgents = false;
      continue;
    }
    const assignment = trimmed.indexOf("=");
    if (assignment < 0) continue;
    const key = trimmed.slice(0, assignment).trim();
    if (/^(?:agents|["']agents["'])(?:\s*\.|\s*$)/.test(key)) {
      return { ambiguous: `${pathLabel} contiene una definición agents no soportada.` };
    }
    if (
      inAgents &&
      new RegExp(
        `(?:["'](?:${CODEX_THREADS_KEY}|${CODEX_THREADS_PREVIOUS_KEY})["']|(?:^|\\.)\\s*(?:${CODEX_THREADS_KEY}|${CODEX_THREADS_PREVIOUS_KEY})\\s*\\.)`,
      ).test(key)
    ) {
      return { ambiguous: `${pathLabel} contiene una clave de concurrencia TOML no soportada.` };
    }
  }
  const sections = [...text.matchAll(/^[ \t]*\[agents\][ \t]*(?:#[^\r\n]*)?\r?$/gm)];
  if (sections.length > 1) {
    return { ambiguous: `${pathLabel} contiene tablas [agents] duplicadas.` };
  }
  if (
    new RegExp(
      `^[ \\t]*agents\\.(?:${CODEX_THREADS_KEY}|${CODEX_THREADS_PREVIOUS_KEY})\\b`,
      "m",
    ).test(text)
  ) {
    return { ambiguous: `${pathLabel} usa una clave de concurrencia punteada no editable con seguridad.` };
  }
  if (!sections.length) {
    return { source, text, value: null, target: null, sectionHeaderEnd: null };
  }

  const section = sections[0];
  const headerEnd = text.indexOf("\n", section.index);
  const contentStart = headerEnd < 0 ? text.length : headerEnd + 1;
  const following = /^[ \t]*(?:\[[^\[\]\r\n]+\]|\[\[[^\[\]\r\n]+\]\])[ \t]*(?:#[^\r\n]*)?\r?$/gm;
  following.lastIndex = contentStart;
  const next = following.exec(text);
  const contentEnd = next?.index ?? text.length;
  const content = text.slice(contentStart, contentEnd);
  const possible = [
    ...content.matchAll(
      new RegExp(`^[ \\t]*(?:${CODEX_THREADS_KEY}|${CODEX_THREADS_PREVIOUS_KEY})\\b[^\\r\\n]*$`, "gm"),
    ),
  ];
  const parsed = [
    ...content.matchAll(
      new RegExp(
        `^([ \\t]*)(${CODEX_THREADS_KEY}|${CODEX_THREADS_PREVIOUS_KEY})([ \\t]*=[ \\t]*)(\\d+)([ \\t]*(?:#[^\\r\\n]*)?)(\\r?)$`,
        "gm",
      ),
    ),
  ];
  if (possible.length !== parsed.length || parsed.length > 1) {
    return { ambiguous: `${pathLabel} contiene una clave de concurrencia TOML ambigua.` };
  }
  const target = parsed[0];
  return {
    source,
    text,
    value: target ? Number(target[4]) : null,
    target: target
      ? {
          index: contentStart + target.index,
          length: target[0].length,
          indent: target[1],
          assignment: target[3],
          suffix: target[5],
          carriageReturn: target[6],
        }
      : null,
    sectionHeaderEnd: contentStart,
  };
}

async function inspectCodexFile(path, label, { rootPath, requireExistingRoot = false } = {}) {
  const allowParentCreation = !requireExistingRoot;
  try {
    if (rootPath) {
      const rootState = await pathState(rootPath);
      if (!rootState) {
        if (requireExistingRoot) {
          return {
            allowParentCreation,
            path,
            label,
            ambiguous: `${label}: CODEX_HOME no existe; se requiere edición manual.`,
          };
        }
      } else if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
        return {
          allowParentCreation,
          path,
          label,
          ambiguous: `${label}: la raíz no es un directorio real seguro.`,
        };
      }
    }
    const state = await pathState(path);
    if (!state) return { allowParentCreation, path, label, exists: false, value: null };
    if (!state.isFile() || state.isSymbolicLink()) {
      return {
        allowParentCreation,
        path,
        label,
        ambiguous: `${label}: config.toml no es un archivo regular seguro.`,
      };
    }
    const bytes = await readFile(path);
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return {
        allowParentCreation,
        path,
        label,
        ambiguous: `${label}: config.toml no contiene UTF-8 válido.`,
      };
    }
    return {
      allowParentCreation,
      path,
      label,
      exists: true,
      mode: state.mode,
      state,
      ...parseCodexToml(source, label),
    };
  } catch (error) {
    return {
      allowParentCreation,
      path,
      label,
      ambiguous: `${label}: no se pudo inspeccionar (${error.message}).`,
    };
  }
}

async function inspectCodexConfiguration(destination) {
  const explicitCodexHome = Object.hasOwn(process.env, "CODEX_HOME") && process.env.CODEX_HOME !== "";
  const globalRoot = explicitCodexHome ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
  const localRoot = join(destination, ".codex");
  const [global, local] = await Promise.all([
    inspectCodexFile(join(globalRoot, "config.toml"), "configuración global de Codex", {
      rootPath: globalRoot,
      requireExistingRoot: explicitCodexHome,
    }),
    inspectCodexFile(join(localRoot, "config.toml"), "configuración local de Codex", {
      rootPath: localRoot,
    }),
  ]);
  const effectiveUnknown = Boolean(local.ambiguous || global.ambiguous);
  const effectiveSource = effectiveUnknown
    ? null
    : typeof local.value === "number"
      ? "local"
      : typeof global.value === "number"
        ? "global"
        : null;
  const effective = effectiveSource ? (effectiveSource === "local" ? local.value : global.value) : null;
  return { global, local, effective, effectiveSource, effectiveUnknown };
}

function renderCodexTomlUpdate(inspection) {
  if (!inspection.exists) return `[agents]\n${CODEX_THREADS_KEY} = ${CODEX_SUBAGENT_CAPACITY}\n`;
  const { source, text, target, sectionHeaderEnd } = inspection;
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  if (target) {
    const line = `${target.indent}${CODEX_THREADS_KEY}${target.assignment}${CODEX_SUBAGENT_CAPACITY}${target.suffix}${target.carriageReturn}`;
    return `${bom}${text.slice(0, target.index)}${line}${text.slice(target.index + target.length)}`;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (sectionHeaderEnd !== null) {
    const separator = sectionHeaderEnd === text.length && !text.endsWith("\n") ? eol : "";
    return `${bom}${text.slice(0, sectionHeaderEnd)}${separator}${CODEX_THREADS_KEY} = ${CODEX_SUBAGENT_CAPACITY}${eol}${text.slice(sectionHeaderEnd)}`;
  }
  const separator = text.length === 0 ? "" : text.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${bom}${text}${separator}[agents]${eol}${CODEX_THREADS_KEY} = ${CODEX_SUBAGENT_CAPACITY}${eol}`;
}

async function assertSafeCodexParent(path, allowParentCreation) {
  const parent = dirname(path);
  await assertSafeDestinationAncestors(parent);
  const state = await pathState(parent);
  if (!state) {
    if (allowParentCreation) return;
    throw new Error("el directorio de configuración no existe");
  }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`el directorio de configuración es un ancestro no seguro: ${parent}`);
  }
}

async function injectConfiguredCodexRace(stage, path) {
  if (
    process.env.AGENTIC_INIT_TEST_CODEX_RACE_STAGE !== stage ||
    !process.env.AGENTIC_INIT_TEST_CODEX_RACE_TARGET
  ) {
    return;
  }
  const external = resolve(process.env.AGENTIC_INIT_TEST_CODEX_RACE_TARGET);
  const externalState = await pathState(external);
  if (!externalState?.isDirectory() || externalState.isSymbolicLink()) {
    throw new Error("el destino de la carrera de Codex no es un directorio real");
  }
  const parent = dirname(path);
  const original = `${parent}.agentic-codex-race-original-${process.pid}`;
  await rename(parent, original);
  try {
    await symlink(external, parent, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await rename(original, parent).catch(() => {});
    throw error;
  }
}

async function atomicWriteCodex(path, content, inspection) {
  await assertSafeCodexParent(path, inspection.allowParentCreation);
  await mkdir(dirname(path), { recursive: true });
  let parentCheck = 0;
  const assertSafeParent = async () => {
    const stage = parentCheck === 0 ? "before-temporary" : "before-mutation";
    parentCheck += 1;
    await injectConfiguredCodexRace(stage, path);
    await assertSafeCodexParent(path, inspection.allowParentCreation);
  };
  if (inspection.exists) {
    await atomicReplaceNoFollow(
      path,
      inspection.source,
      inspection.state,
      content,
      inspection.mode,
      inspection.label,
      assertSafeParent,
    );
  } else {
    await atomicCreateNoFollow(path, content, null, inspection.label, assertSafeParent);
  }
}

async function askCodexConfiguration(inspection) {
  const readline = createInterface({ input, output });
  const recommendLocal =
    inspection.local.value !== null && inspection.local.value < CODEX_SUBAGENT_CAPACITY;
  try {
    output.write(
      `\nCodex no tiene capacidad efectiva para ${CODEX_SUBAGENT_CAPACITY} subagentes en este proyecto.\n`,
    );
    output.write(
      `La capa recomienda habilitar capacidad técnica para ${CODEX_SUBAGENT_CAPACITY}; los workflows conservan sus propios topes.\n\n`,
    );
    output.write("¿Dónde desea configurarlo?\n");
    output.write(`[g] Global: todos los proyectos${recommendLocal ? "" : " (recomendado)"}\n`);
    output.write(`[l] Local: solamente este proyecto${recommendLocal ? " (recomendado)" : ""}\n`);
    output.write("[n] Ninguno\n");
    const answer = (await readline.question("> ")).trim().toLowerCase();
    if (answer === "g" || answer === "global") return "global";
    if (answer === "l" || answer === "local") return "local";
    return "none";
  } finally {
    readline.close();
  }
}

async function applyCodexConfiguration(options, inspection, { ready, warnings, pending }) {
  const ambiguity = inspection.local.ambiguous ?? inspection.global.ambiguous;
  if (ambiguity) {
    warnings.push(`Valor efectivo de Codex desconocido por TOML ambiguo o ruta no segura: ${ambiguity}`);
    pending.push("Realizar manualmente la edición de concurrencia de Codex.");
    return;
  }
  if (inspection.effective !== null && inspection.effective >= CODEX_SUBAGENT_CAPACITY) {
    ready.push(
      `Codex ya tiene un límite efectivo de ${inspection.effective} (${inspection.effectiveSource}); no se modifica.`,
    );
    return;
  }

  let choice = options.codexConfig;
  if (!choice && !options.dryRun && !options.yes && isInteractiveTerminal()) {
    choice = await askCodexConfiguration(inspection);
  }
  if (!choice) {
    pending.push("Configuración de Codex pendiente; --yes no autoriza modificarla sin --codex-config.");
    return;
  }
  if (choice === "none") {
    ready.push("Configuración de Codex conservada por elección explícita.");
    return;
  }

  const selected = inspection[choice];
  if (
    choice === "global" &&
    inspection.local.value !== null &&
    inspection.local.value < CODEX_SUBAGENT_CAPACITY
  ) {
    warnings.push(
      `La configuración local tiene precedencia: este proyecto seguirá usando ${inspection.local.value} aunque se elija global.`,
    );
    pending.push("Actualizar localmente la concurrencia de Codex para corregir el valor efectivo.");
  }
  if (selected.value !== null && selected.value >= CODEX_SUBAGENT_CAPACITY) {
    ready.push(`La configuración ${choice} ya declara ${selected.value}; no se reduce ni modifica.`);
    return;
  }
  if (options.dryRun) {
    ready.push(`Plan de configuración ${choice} de Codex calculado sin escrituras.`);
    return;
  }
  try {
    const latestParent = await pathState(dirname(selected.path));
    const latestState = await pathState(selected.path);
    if (
      latestParent &&
      (!latestParent.isDirectory() || latestParent.isSymbolicLink())
    ) {
      throw new Error("el directorio de configuración cambió o no es seguro");
    }
    if (!latestParent && !selected.allowParentCreation) {
      throw new Error("el directorio de configuración no existe");
    }
    if (selected.exists) {
      const latestSource =
        latestState?.isFile() && !latestState.isSymbolicLink()
          ? await readFile(selected.path, "utf8")
          : null;
      if (latestSource !== selected.source) {
        throw new Error("config.toml cambió después de la inspección");
      }
    } else if (latestState) {
      throw new Error("config.toml apareció después de la inspección");
    }
    await atomicWriteCodex(selected.path, renderCodexTomlUpdate(selected), selected);
    ready.push(
      `Configuración ${choice} de Codex actualizada a ${CODEX_SUBAGENT_CAPACITY} de forma atómica.`,
    );
  } catch (error) {
    warnings.push(`La capa quedó actualizada, pero no se pudo escribir Codex: ${error.message}`);
    pending.push(`Editar manualmente ${selected.path}.`);
  }
}

async function validateSubagentAdapters() {
  const errors = [];

  for (const role of ROLE_NAMES) {
    const codexPath = join(SOURCE_ROOT, ".codex", "agents", `${role}.toml`);
    const claudePath = join(SOURCE_ROOT, ".claude", "agents", `${role}.md`);
    const [codex, claude] = await Promise.all([
      readFile(codexPath, "utf8"),
      readFile(claudePath, "utf8"),
    ]);

    if (!new RegExp(`^name\\s*=\\s*"${role}"$`, "m").test(codex)) {
      errors.push(`.codex/agents/${role}.toml no declara el nombre esperado.`);
    }
    if (!codex.includes(`.agents/roles/${role}.md`)) {
      errors.push(`.codex/agents/${role}.toml no apunta al rol canónico.`);
    }
    if (!new RegExp(`^name:\\s*${role}$`, "m").test(claude)) {
      errors.push(`.claude/agents/${role}.md no declara el nombre esperado.`);
    }
    if (!claude.includes(`.agents/roles/${role}.md`)) {
      errors.push(`.claude/agents/${role}.md no apunta al rol canónico.`);
    }
    for (const [adapterPath, adapter] of [
      [`.codex/agents/${role}.toml`, codex],
      [`.claude/agents/${role}.md`, claude],
    ]) {
      if (!adapter.includes("RoleReport") || !adapter.includes("contextPaths")) {
        errors.push(`${adapterPath} no consume WorkEnvelope/contextPaths ni devuelve RoleReport.`);
      }
      if (!/no\s+uses/i.test(adapter) || !adapter.includes("OrchestrationKernel.apply")) {
        errors.push(`${adapterPath} no prohíbe la mutación de estado desde el rol.`);
      }
      if (adapter.includes(".agents/kernel/orchestration-kernel.mjs")) {
        errors.push(`${adapterPath} todavía entrega ownership del kernel al rol.`);
      }
    }
  }

  const [codexEvaluator, claudeEvaluator, claudeImport, claudeSkill] = await Promise.all([
    readFile(join(SOURCE_ROOT, ".codex", "agents", "evaluador.toml"), "utf8"),
    readFile(join(SOURCE_ROOT, ".claude", "agents", "evaluador.md"), "utf8"),
    readFile(join(SOURCE_ROOT, "CLAUDE.md"), "utf8"),
    readFile(join(SOURCE_ROOT, ".claude", "skills", "orquestar", "SKILL.md"), "utf8"),
  ]);
  if (!/^sandbox_mode\s*=\s*"read-only"$/m.test(codexEvaluator)) {
    errors.push("El Evaluador de Codex no declara sandbox read-only.");
  }
  if (!/^permissionMode:\s*plan$/m.test(claudeEvaluator)) {
    errors.push("El Evaluador de Claude no declara permissionMode: plan.");
  }
  const evaluatorTools = claudeEvaluator.match(/^tools:\s*(.+)$/m)?.[1] ?? "";
  if (/(^|,\s*)(Write|Edit)(\s*,|$)/.test(evaluatorTools)) {
    errors.push("El Evaluador de Claude expone herramientas de edición.");
  }
  if (!/^@AGENTS\.md$/m.test(claudeImport)) {
    errors.push("CLAUDE.md no importa AGENTS.md.");
  }
  if (!claudeSkill.includes(".agents/skills/orquestar/SKILL.md")) {
    errors.push("El wrapper de Claude no apunta a la skill canónica.");
  }
  for (const [adapterPath, adapter] of [
    ["CLAUDE.md", claudeImport],
    [".claude/skills/orquestar/SKILL.md", claudeSkill],
  ]) {
    if (!adapter.includes("<!-- agentic-protocol -->")) {
      errors.push(`${adapterPath} no declara el protocolo actual.`);
    }
    if (!adapter.includes(".agents/kernel/orchestration-kernel.mjs")) {
      errors.push(`${adapterPath} no reserva el runtime al kernel actual.`);
    }
  }
  if (!claudeSkill.includes("WorkEnvelope") || !claudeSkill.includes("RoleReport")) {
    errors.push("El wrapper de Claude no conserva WorkEnvelope → RoleReport.");
  }

  if (errors.length) {
    throw new Error(`Adapters de subagentes inválidos:\n${errors.map((item) => `- ${item}`).join("\n")}`);
  }
  return { codex: ROLE_NAMES.length, claude: ROLE_NAMES.length };
}

async function packageManifestErrors() {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(SOURCE_ROOT, "package.json"), "utf8"));
  } catch (error) {
    return [`package.json de la distribución no es legible: ${error.message}`];
  }

  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    errors.push("package.json no declara un nombre publicable.");
  }
  if (!SEMVER_PATTERN.test(manifest.version ?? "")) {
    errors.push("package.json no declara una versión semver válida.");
  }
  if (manifest.private === true) {
    errors.push("package.json está marcado como privado y no podría distribuirse.");
  }
  if (manifest.type !== "module") {
    errors.push("package.json debe declarar type: module para los entrypoints .mjs.");
  }
  if (manifest.bin?.agentic !== "./bin/agentic.mjs") {
    errors.push("package.json no expone el ejecutable `agentic` en ./bin/agentic.mjs.");
  }
  if (manifest.agentic?.distributionVersion !== manifest.version) {
    errors.push("agentic.distributionVersion debe coincidir con package.json.version.");
  }
  const requiredExports = {
    "./conformance": "./.agents/conformance/protocol-conformance.mjs",
    "./kernel": "./.agents/kernel/orchestration-kernel.mjs",
    "./kernel/adapters": "./.agents/kernel/adapters.mjs",
    "./kernel/protocol": "./.agents/kernel/protocol.mjs",
    "./protocol.json": "./.agents/protocol.json",
  };
  for (const [key, target] of Object.entries(requiredExports)) {
    if (manifest.exports?.[key] !== target) {
      errors.push(`package.json no expone ${key} en ${target}.`);
    }
  }
  for (const key of Object.keys(manifest.exports ?? {})) {
    if (!Object.hasOwn(requiredExports, key)) {
      errors.push(`package.json expone un entrypoint no canónico: ${key}.`);
    }
  }
  if (typeof manifest.engines?.node !== "string") {
    errors.push("package.json no declara la versión mínima de Node.js.");
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundleDependencies",
  ]) {
    const declared = manifest[field];
    const empty = !declared || (Array.isArray(declared) ? !declared.length : !Object.keys(declared).length);
    if (!empty) {
      errors.push(`package.json declara ${field}; la distribución debe usar solo la biblioteca estándar.`);
    }
  }

  const declaredFiles = Array.isArray(manifest.files) ? [...manifest.files].sort() : null;
  if (!declaredFiles) {
    errors.push("package.json no declara la lista explícita `files`.");
  } else {
    const missing = PACKAGE_FILES.filter((path) => !declaredFiles.includes(path));
    const extra = declaredFiles.filter((path) => !PACKAGE_FILES.includes(path));
    if (missing.length) {
      errors.push(`package.json omite archivos canónicos: ${missing.join(", ")}.`);
    }
    if (extra.length) {
      errors.push(`package.json empaqueta archivos no canónicos: ${extra.join(", ")}.`);
    }
  }

  return errors;
}

async function validateTemplateDistribution() {
  const errors = [];

  if (!TEMPLATE_FILES.includes(GOLDEN_RULE_POLICY)) {
    errors.push(`El inventario de plantilla omite ${GOLDEN_RULE_POLICY}.`);
  }
  if (new Set(PACKAGE_FILES).size !== PACKAGE_FILES.length) {
    errors.push("El inventario de distribución contiene rutas duplicadas.");
  }
  for (const relativePath of PACKAGE_FILES) {
    const state = await pathState(join(SOURCE_ROOT, ...relativePath.split("/")));
    if (!state?.isFile() || state.isSymbolicLink()) {
      errors.push(`Falta un archivo regular de distribución: ${relativePath}.`);
    }
  }
  const developmentCheckout = Boolean(await pathState(join(SOURCE_ROOT, "tests")));
  if (developmentCheckout) {
    let rootIgnorePresent = false;
    for (const relativePath of DEVELOPMENT_FILES) {
      const state = await pathState(join(SOURCE_ROOT, ...relativePath.split("/")));
      if (!state?.isFile() || state.isSymbolicLink()) {
        errors.push(`Falta un archivo del repositorio de desarrollo: ${relativePath}.`);
      } else if (relativePath === ".gitignore") {
        rootIgnorePresent = true;
      }
    }
    if (rootIgnorePresent) {
      const rootIgnore = (await readFile(join(SOURCE_ROOT, ".gitignore"), "utf8")).split(/\r?\n/);
      for (const ignoredPath of [
        ".codegraph/",
        ".engram/",
        "node_modules/",
        "*.tgz",
        ".agents/sessions/*",
        ".claude/*.local.json",
      ]) {
        if (!rootIgnore.includes(ignoredPath)) {
          errors.push(`.gitignore no excluye ${ignoredPath}.`);
        }
      }
    }
  }
  errors.push(...(await packageManifestErrors()));
  try {
    await assertProtocolConformance({ root: SOURCE_ROOT });
  } catch (error) {
    errors.push(`Conformidad del protocolo inválida: ${error.message}`);
  }

  const [sessionsIgnore, devSession, subdevSession, rootAgents, orchestration, orchestrationSkill] =
    await Promise.all([
      readFile(templateSourcePath(".agents/sessions/.gitignore"), "utf8"),
      readFile(join(SOURCE_ROOT, ".agents", "templates", "dev-session.md"), "utf8"),
      readFile(join(SOURCE_ROOT, ".agents", "templates", "subdev-session.md"), "utf8"),
      readFile(join(SOURCE_ROOT, "AGENTS.md"), "utf8"),
      readFile(join(SOURCE_ROOT, ...ORCHESTRATION_POLICY.split("/")), "utf8"),
      readFile(join(SOURCE_ROOT, ".agents", "skills", "orquestar", "SKILL.md"), "utf8"),
    ]);
  for (const relativePath of PACKAGE_FILES) {
    if (/(^|\/)\.(?:git|npm)ignore$/.test(relativePath)) {
      errors.push(`npm no puede transportar ${relativePath} con su nombre canónico.`);
    }
  }
  if (!/^\*$/m.test(sessionsIgnore) || !/^!\.gitignore$/m.test(sessionsIgnore)) {
    errors.push(".agents/sessions/.gitignore no excluye todas las DevSession reales.");
  }
  if (!/^- Contaminación de origen:/m.test(rootAgents)) {
    errors.push("El contrato raíz no declara Contaminación de origen.");
  }
  try {
    const rootContract = inspectContract(rootAgents, "AGENTS.md de la plantilla");
    if (!rootContract.present) {
      errors.push("AGENTS.md no contiene el contrato canónico.");
    } else {
      const rootFields = parseContractFields(rootAgents);
      const missingIds = REQUIRED_CONTRACT_FIELDS.filter((field) => !rootFields.has(field));
      const declaredIds = [
        ...rootContract.text.matchAll(/<!-- agentic-contract-field ([A-Za-z][A-Za-z0-9]*) -->/g),
      ].map((match) => match[1]);
      if (missingIds.length || declaredIds.length !== REQUIRED_CONTRACT_FIELDS.length) {
        errors.push("AGENTS.md no declara una vez cada campo contractual canónico con ID estable.");
      }
    }
  } catch (error) {
    errors.push(`AGENTS.md contiene un contrato canónico inválido: ${error.message}`);
  }
  const developmentStart = rootAgents.indexOf("## Desarrollo");
  const developmentEnd = rootAgents.indexOf("\n## ", developmentStart + 1);
  const developmentSection =
    developmentStart < 0
      ? ""
      : rootAgents.slice(developmentStart, developmentEnd < 0 ? rootAgents.length : developmentEnd);
  if (!developmentSection.includes(GOLDEN_RULE_POLICY)) {
    errors.push("AGENTS.md no activa la Regla de Oro para tareas directas y orquestadas.");
  }
  if (!orchestration.includes(GOLDEN_RULE_POLICY)) {
    errors.push("orquestacion.md no registra los consumidores obligatorios de la Regla de Oro.");
  }
  if (!rootAgents.includes(ORCHESTRATION_POLICY)) {
    errors.push(`AGENTS.md no referencia ${ORCHESTRATION_POLICY}.`);
  }
  if (!linksToCanonicalPolicy(orchestrationSkill)) {
    errors.push("La skill orquestar no enlaza la política canónica de orquestación.");
  }

  const devSessionFields = [
    "Objetivo:",
    "Workflow:",
    "Modo:",
    "Estrategia light:",
    "Fase actual:",
    "## Sector de importancia",
    "## Reglas `AGENTS.md` efectivas por sector",
    "## Especificación",
    "## Tareas",
    "## Archivos modificados",
    "## Tests creados",
    "## Validación",
    "## Veredicto del evaluador",
    "## Candidatos a memoria",
    "## Próximos pasos",
  ];
  for (const field of devSessionFields) {
    if (!devSession.includes(field)) errors.push(`DevSession no contiene: ${field}`);
  }
  for (const field of [
    "Sesión:",
    "Fase:",
    "Rol:",
    "Intento:",
    "Revisión fuente:",
    "## Rutas de contexto seleccionadas",
    "## Contrato de salida esperado",
    "## Reporte contractual producido",
    "## Estado de consolidación en la DevSession global",
  ]) {
    if (!subdevSession.includes(field)) errors.push(`SubDevSession no contiene: ${field}`);
  }
  if (/Según la DevSession global|^- DevSession global:/m.test(subdevSession)) {
    errors.push("SubDevSession remite al ledger global en lugar de materializar el contexto mínimo.");
  }
  if (!orchestration.includes(".agents/kernel/orchestration-kernel.mjs")) {
    errors.push("orquestacion.md no referencia el kernel canónico de sesiones.");
  }
  if (
    !orchestration.includes("## Proyección mínima de contexto") ||
    !orchestration.includes("`contextPaths`") ||
    !orchestrationSkill.includes("`contextPaths`")
  ) {
    errors.push("La política y la skill no declaran la proyección mínima de contexto.");
  }

  const goldenRuleConsumers = new Set(["planificador", "implementador", "tester", "evaluador"]);
  for (const role of ROLE_NAMES) {
    const content = await readFile(join(SOURCE_ROOT, ".agents", "roles", `${role}.md`), "utf8");
    for (const heading of ["Entradas", "Proceso", "Salida", "Límites"]) {
      if (!new RegExp(`^## ${heading}$`, "m").test(content)) {
        errors.push(`.agents/roles/${role}.md no contiene la sección ${heading}.`);
      }
    }
    if (
      goldenRuleConsumers.has(role) &&
      !content.includes(`\`${GOLDEN_RULE_POLICY}\``)
    ) {
      errors.push(`.agents/roles/${role}.md no consume ${GOLDEN_RULE_POLICY}.`);
    }
    if (!linksToCanonicalPolicy(content)) {
      errors.push(`.agents/roles/${role}.md no enlaza ${ORCHESTRATION_POLICY}.`);
    }
    const inputs = content.match(/^## Entradas\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? "";
    if (!inputs.includes("`WorkEnvelope` vigente") || !inputs.includes("`contextPaths`")) {
      errors.push(`.agents/roles/${role}.md no consume el sobre mínimo común.`);
    }
    if (
      inputs.includes("- DevSession vigente.") ||
      inputs.includes("Especificación y DevSession") ||
      inputs.includes("Especificación, decisiones y DevSession")
    ) {
      errors.push(`.agents/roles/${role}.md todavía solicita la DevSession completa.`);
    }
  }

  const roleNames = new Set(ROLE_NAMES.map((role) => normalizeLabel(role)));
  for (const workflow of ["architecture", "bugfix", "feature", "refactor"]) {
    const content = await readFile(
      join(SOURCE_ROOT, ".agents", "workflows", `${workflow}.md`),
      "utf8",
    );
    if (!linksToCanonicalPolicy(content)) {
      errors.push(`.agents/workflows/${workflow}.md no enlaza ${ORCHESTRATION_POLICY}.`);
    }
    const phaseIds = new Set();
    const phaseMarkers = [...content.matchAll(/<!-- agentic-phase (\{[^\n]+\}) -->/g)];
    if (!phaseMarkers.length) errors.push(`El workflow ${workflow} no declara fases canónicas.`);
    for (const match of phaseMarkers) {
      let phase;
      try {
        phase = JSON.parse(match[1]);
      } catch {
        errors.push(`El workflow ${workflow} contiene un marcador de fase inválido.`);
        continue;
      }
      if (typeof phase.id !== "string" || typeof phase.role !== "string") {
        errors.push(`El workflow ${workflow} contiene una fase sin id o rol.`);
        continue;
      }
      if (phaseIds.has(phase.id)) {
        errors.push(`El workflow ${workflow} repite la fase ${phase.id}.`);
      }
      phaseIds.add(phase.id);
      if (!roleNames.has(normalizeLabel(phase.role))) {
        errors.push(`El workflow ${workflow} referencia un rol inexistente: ${phase.role}.`);
      }
    }
    const lightMarkers = [
      ...content.matchAll(/<!-- agentic-light-sequence (\{[^\n]+\}) -->/g),
    ];
    const expectedLightMarkers = workflow === "architecture" ? 0 : 1;
    if (lightMarkers.length !== expectedLightMarkers) {
      errors.push(
        workflow === "architecture"
          ? "El workflow architecture no admite una secuencia light compacta."
          : `El workflow ${workflow} debe declarar una única secuencia light compacta.`,
      );
    }
    if (lightMarkers.length === 1) {
      let contract;
      try {
        contract = JSON.parse(lightMarkers[0][1]);
      } catch {
        errors.push(`El workflow ${workflow} contiene una secuencia light inválida.`);
        continue;
      }
      if (
        !contract ||
        typeof contract !== "object" ||
        Array.isArray(contract) ||
        Object.keys(contract).length !== 1 ||
        !Array.isArray(contract.phases) ||
        !contract.phases.length ||
        contract.phases.some((phaseId) => typeof phaseId !== "string") ||
        new Set(contract.phases).size !== contract.phases.length
      ) {
        errors.push(`El workflow ${workflow} contiene una secuencia light ambigua.`);
        continue;
      }
      for (const phaseId of contract.phases) {
        if (!phaseIds.has(phaseId)) {
          errors.push(
            `El workflow ${workflow} referencia una fase light inexistente: ${phaseId}.`,
          );
        }
      }
    }
  }

  const markdownFiles = PACKAGE_FILES.filter((path) => path.endsWith(".md"));
  for (const relativePath of [...new Set(markdownFiles)]) {
    const absolutePath = join(SOURCE_ROOT, ...relativePath.split("/"));
    const content = await readFile(absolutePath, "utf8");
    for (const rawTarget of markdownLinkTargets(content)) {
      if (/^(?:[a-z]+:|#)/i.test(rawTarget)) continue;
      const fileTarget = rawTarget.split("#")[0];
      // La documentación interna no viaja en el paquete: sus enlaces solo pueden
      // comprobarse en el checkout de desarrollo, donde esos archivos existen.
      if (
        !developmentCheckout &&
        DEVELOPMENT_ONLY_PREFIXES.some((prefix) => fileTarget.startsWith(prefix))
      ) {
        continue;
      }
      const resolvedTarget = resolve(dirname(absolutePath), decodeURIComponent(fileTarget));
      if (!existsSync(resolvedTarget)) {
        errors.push(`${relativePath} enlaza una ruta inexistente: ${rawTarget}.`);
      }
    }
  }

  if (errors.length) {
    throw new Error(
      `Integridad estructural inválida:\n${errors.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  return { files: PACKAGE_FILES.length };
}

async function checkTargetIgnores(destination, warnings, pending) {
  const ignorePath = join(destination, ".gitignore");
  const state = await pathState(ignorePath);
  if (!state || !state.isFile() || state.isSymbolicLink()) {
    warnings.push("El destino no tiene un .gitignore regular para CodeGraph y Engram.");
    pending.push("Añadir `.codegraph/` y `.engram/` al .gitignore del proyecto.");
    return false;
  }
  const entries = new Set(
    (await readFile(ignorePath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  const missing = [".codegraph/", ".engram/"].filter((entry) => !entries.has(entry));
  if (missing.length) {
    warnings.push(`.gitignore no excluye: ${missing.join(", ")}.`);
    pending.push("Completar .gitignore antes de versionar índices o memorias locales.");
    return false;
  }
  return true;
}

function checkCommand(command, arguments_) {
  let executable = command;
  let result;
  const spawnOptions = {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  };

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? join(parse(process.execPath).root, "Windows");
    const extensions = /\.[A-Za-z0-9]+$/.test(command)
      ? [""]
      : [".exe", ".com", ".cmd", ".bat", ""];
    executable = (process.env.PATH ?? "")
      .split(delimiter)
      .map((directory) => directory.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .flatMap((directory) => extensions.map((extension) => join(directory, `${command}${extension}`)))
      .find((candidate) => existsSync(candidate));
    if (!executable) return { available: false, detail: "no encontrado" };

    if (/\.(?:cmd|bat)$/i.test(executable)) {
      if ([executable, ...arguments_].some((value) => /["\r\n]/.test(value))) {
        return { available: false, detail: "ruta no segura para cmd.exe" };
      }
      const environment = {
        ...process.env,
        AGENTIC_INIT_TOOL: executable,
      };
      const argumentReferences = arguments_.map((value, index) => {
        const name = `AGENTIC_INIT_ARG_${index}`;
        environment[name] = value;
        return `"%${name}%"`;
      });
      const commandLine = `call "%AGENTIC_INIT_TOOL%" ${argumentReferences.join(" ")}`.trim();
      result = spawnSync(commandLine, {
        ...spawnOptions,
        env: environment,
        shell: process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe"),
      });
    } else {
      result = spawnSync(executable, arguments_, spawnOptions);
    }
  } else {
    result = spawnSync(executable, arguments_, spawnOptions);
  }

  if (result.error) return { available: false, detail: result.error.code ?? result.error.message };
  return {
    available: result.status === 0,
    detail: (result.stdout || result.stderr || `código ${result.status}`).trim(),
    stdout: result.stdout?.trim() ?? "",
  };
}

async function run(options) {
  assertSafeDestination(options.destination);
  const warnings = [];
  const pending = [];
  const ready = [];
  const missingRequirements = [];

  await access(SOURCE_ROOT, fsConstants.R_OK);
  await assertSafeDestinationAncestors(options.destination);
  const destinationState = await pathState(options.destination);
  if (destinationState && (!destinationState.isDirectory() || destinationState.isSymbolicLink())) {
    throw new Error("El destino debe ser un directorio real, no un archivo ni un enlace simbólico.");
  }

  const project = await detectProject(options.destination, warnings);
  const distributionVersion = await readDistributionVersion();
  const installedLayer = await detectInstalledLayer(options.destination);
  if (options.operation === "update" && !installedLayer.present) {
    const error = new Error(
      "No se detectó una capa agéntica existente. Use `agentic init [destino]`.",
    );
    error.exitCode = 2;
    throw error;
  }
  if (options.operation === "update" && installedLayer.invalidVersion) {
    const error = new Error(
      `${LAYER_VERSION_FILE} no contiene SemVer válido (${installedLayer.invalidVersion}); no se escribió ningún archivo.`,
    );
    error.exitCode = 2;
    throw error;
  }
  const layerClassification = installedLayer.present
    ? classifyInstalledLayer(installedLayer, distributionVersion)
    : null;
  if (
    options.operation === "update" &&
    layerClassification === "posterior" &&
    !options.allowDowngrade
  ) {
    const error = new Error(
      `La capa instalada ${installedLayer.version} es posterior a ${distributionVersion}; use --allow-downgrade para autorizarlo.`,
    );
    error.exitCode = 2;
    throw error;
  }
  let replaceLayer = options.operation === "update" || options.force;
  let replacementConfirmed = false;
  let templatePlan = await planTemplateFiles(options.destination, replaceLayer);

  // Una divergencia sobre una capa ya instalada es un reemplazo de versión, no
  // una colisión con archivos ajenos: se ofrece decidir en vez de abortar.
  if (templatePlan.collisions.length && installedLayer.present && !replaceLayer) {
    const interactive = !options.yes && !options.dryRun && isInteractiveTerminal();
    if (interactive) {
      const decision = await confirmLayerReplacement(
        installedLayer,
        templatePlan.collisions,
        distributionVersion,
      );
      if (decision !== "replace") {
        const error = new Error("Cancelado por el usuario; no se escribió ningún archivo.");
        error.exitCode = 3;
        throw error;
      }
      replaceLayer = true;
      replacementConfirmed = true;
      templatePlan = await planTemplateFiles(options.destination, true);
    } else {
      const error = new Error(
        [
          `Se detectó una ${describeInstalledLayer(installedLayer, distributionVersion)}.`,
          templatePlan.collisions.length === 1
            ? "Difiere 1 archivo canónico:"
            : `Difieren ${templatePlan.collisions.length} archivos canónicos:`,
          ...templatePlan.collisions.map((path) => `- ${path}`),
          "Reemplazar: repetir con --force. Cancelar: no volver a ejecutar; no se escribió ningún archivo.",
        ].join("\n"),
      );
      error.exitCode = 2;
      throw error;
    }
  }

  if (templatePlan.collisions.length) {
    const error = new Error(
      `Colisiones detectadas; no se escribió ningún archivo:\n${templatePlan.collisions
        .map((path) => `- ${path}`)
        .join("\n")}${
        replaceLayer
          ? "\n--force no reemplaza enlaces simbólicos, directorios ni ancestros no seguros."
          : "\nResolver manualmente o usar --force para reemplazar archivos canónicos divergentes."
      }`,
    );
    error.exitCode = 2;
    throw error;
  }
  const adapterCounts = await validateSubagentAdapters();
  const distribution = await validateTemplateDistribution();

  const sourceAgents = await readFile(join(SOURCE_ROOT, "AGENTS.md"), "utf8");
  const sourceContract = inspectContract(sourceAgents, "AGENTS.md de la plantilla");
  if (!sourceContract.present) {
    throw new Error("AGENTS.md de la plantilla no contiene AGENTIC_PROJECT_CONTRACT.");
  }
  const destinationAgentsPath = join(options.destination, "AGENTS.md");
  const destinationAgentsState = await pathState(destinationAgentsPath);
  if (
    destinationAgentsState &&
    (!destinationAgentsState.isFile() || destinationAgentsState.isSymbolicLink())
  ) {
    const error = new Error("Colisión en AGENTS.md: el destino no es un archivo regular.");
    error.exitCode = 2;
    throw error;
  }
  const currentAgents = destinationAgentsState
    ? await readFile(destinationAgentsPath, "utf8")
    : sourceAgents;
  const destinationContract = inspectContract(currentAgents, "AGENTS.md del destino");
  const baselineContract = Boolean(
    destinationAgentsState &&
      options.destination !== SOURCE_ROOT &&
      existsSync(join(options.destination, ".git")) &&
      destinationContract.text === sourceContract.text &&
      !destinationContract.text?.includes(GENERATED_CONTRACT_MARKER),
  );
  const parsedContract =
    destinationAgentsState && !baselineContract
      ? parseContract(currentAgents)
      : { fields: new Map(), unmappable: [] };
  const existingFields = parsedContract.fields;
  if (options.purpose) existingFields.set("purpose", options.purpose);
  if (options.gitStrategy) existingFields.set("gitStrategy", options.gitStrategy);
  let additionalRules = [];
  if (parsedContract.unmappable.length) {
    const interactive =
      options.operation === "update" &&
      !options.yes &&
      !options.dryRun &&
      isInteractiveTerminal();
    if (!interactive) throw unmappableContractError(parsedContract.unmappable);
    additionalRules = await resolveUnmappableContractEntries(
      parsedContract.unmappable,
      existingFields,
    );
  }
  resolveContractFacts({
    options,
    project,
    existingFields,
    baselineContract,
    templatePurpose: baselineContract ? await readReadmePurpose(SOURCE_ROOT, warnings) : null,
  });
  const targetIgnoresReady = await checkTargetIgnores(
    options.destination,
    warnings,
    pending,
  );
  const canonicalTemplateSource = Boolean(
    options.destination === SOURCE_ROOT &&
      destinationContract.text === sourceContract.text &&
      !destinationContract.text?.includes(GENERATED_CONTRACT_MARKER) &&
      REQUIRED_CONTRACT_FIELDS.every((field) => existingFields.has(field)),
  );
  const contract = canonicalTemplateSource
    ? destinationContract.text
    : renderContract(project, existingFields);
  const gaps = contractGaps(contract);
  const nextAgents = appendAdditionalProjectRules(
    replaceContract(currentAgents, contract),
    additionalRules,
  );
  const agentsAction = currentAgents === nextAgents ? "validate" : destinationAgentsState ? "update" : "create";

  const orphans =
    replaceLayer && installedLayer.present ? await planOrphanFiles(options.destination) : [];

  const versionPath = join(options.destination, ...LAYER_VERSION_FILE.split("/"));
  const versionContent = `${distributionVersion}\n`;
  const versionState = await pathState(versionPath);
  if (versionState && (!versionState.isFile() || versionState.isSymbolicLink())) {
    const error = new Error(`Colisión en ${LAYER_VERSION_FILE}: el destino no es un archivo regular.`);
    error.exitCode = 2;
    throw error;
  }
  const currentVersionContent = versionState ? await readFile(versionPath, "utf8") : null;
  const versionAction =
    currentVersionContent === versionContent ? "validate" : versionState ? "update" : "create";
  const codexInspection =
    options.operation === "update" ? await inspectCodexConfiguration(options.destination) : null;

  console.log(options.dryRun ? "PLAN (sin escrituras)" : "ACCIONES");
  if (installedLayer.present) {
    console.log(
      `- detectada ${describeInstalledLayer(installedLayer, distributionVersion)} (${layerClassification})${
        layerClassification === "posterior" && options.allowDowngrade
          ? "; downgrade autorizado"
          : ""
      }`,
    );
  }
  for (const action of templatePlan.actions) {
    console.log(`- ${ACTION_LABELS[action.type]}: ${action.relativePath}`);
  }
  for (const orphan of orphans) {
    console.log(`- eliminar residuo de otra versión: ${orphan.relativePath}`);
  }
  console.log(`- ${ACTION_LABELS[agentsAction]}: AGENTS.md`);
  console.log(`- ${ACTION_LABELS[versionAction]}: ${LAYER_VERSION_FILE}`);
  console.log(`- validar integridad estructural de ${distribution.files} archivos distribuibles`);
  console.log(
    `- validar ${adapterCounts.codex} adapters de Codex y ${adapterCounts.claude} de Claude`,
  );
  if (options.codeGraphAction) {
    const verb = options.codeGraphAction === "init" ? "inicializar" : "sincronizar";
    console.log(`- ${verb} CodeGraph (confirmación explícita)`);
  } else {
    console.log("- comprobar CodeGraph con status, sin modificarlo");
  }
  console.log("- comprobar la disponibilidad del ejecutable de Engram");
  console.log("- comprobar exclusiones locales en .gitignore");
  if (options.operation === "update") {
    const detected = (item) =>
      item.ambiguous ? "ambiguo" : item.value === null ? "ausente" : String(item.value);
    console.log(
      `- Codex detectado: global=${detected(codexInspection.global)}, local=${detected(codexInspection.local)}, efectivo=${
        codexInspection.effectiveUnknown ? "desconocido" : (codexInspection.effective ?? "ausente")
      }`,
    );
    if (codexInspection.local.ambiguous || codexInspection.global.ambiguous) {
      console.log("- configuración de Codex ambigua; dejar una edición manual pendiente");
    } else if (
      codexInspection.effective !== null &&
      codexInspection.effective >= CODEX_SUBAGENT_CAPACITY
    ) {
      console.log("- Codex ya cumple el mínimo efectivo; no preguntar ni escribir configuración");
    } else if (options.codexConfig === "global") {
      console.log("- revisar y, si corresponde, actualizar la configuración global de Codex");
    } else if (options.codexConfig === "local") {
      console.log("- revisar y, si corresponde, actualizar la configuración local de Codex");
    } else if (options.codexConfig === "none") {
      console.log("- conservar sin cambios la configuración de Codex (elección explícita: none)");
    } else {
      console.log(
        "- configuración de Codex pendiente; ofrecer global, local o none (requiere elección explícita)",
      );
    }
  }

  if (!options.dryRun) {
    // Confirmar el reemplazo ya autorizó estas escrituras: no se vuelve a pedir.
    const interactive = !options.yes && !replacementConfirmed && isInteractiveTerminal();
    if (
      interactive &&
      !(await confirmApplication(templatePlan.actions, agentsAction, orphans, versionAction))
    ) {
      const error = new Error("Cancelado por el usuario; no se escribió ningún archivo.");
      error.exitCode = 3;
      throw error;
    }
    if (options.operation === "update" && !options.yes && !interactive) {
      const error = new Error(
        "Cancelado: update exige confirmación interactiva o --yes; no se escribió ningún archivo.",
      );
      error.exitCode = 3;
      throw error;
    }

    try {
      await revalidateLayerPlan({
        destination: options.destination,
        templateActions: templatePlan.actions,
        destinationAgentsPath,
        destinationAgentsState,
        currentAgents,
        orphans,
        versionPath,
        versionState,
        currentVersionContent,
      });
    } catch (error) {
      error.exitCode = 2;
      throw error;
    }
    const applied = await applyLayerTransaction({
      options,
      templateActions: templatePlan.actions,
      agentsAction,
      destinationAgentsPath,
      destinationAgentsState,
      currentAgents,
      nextAgents,
      orphans,
      versionAction,
      versionPath,
      versionState,
      currentVersionContent,
      versionContent,
    });
    if (applied.removed) await removeEmptyManagedDirectories(options.destination);

    ready.push(`${applied.copied} archivos de la capa copiados.`);
    const overwritten = applied.overwritten;
    if (overwritten) {
      ready.push(
        overwritten === 1
          ? "1 archivo canónico divergente reemplazado."
          : `${overwritten} archivos canónicos divergentes reemplazados.`,
      );
    }
    if (applied.removed) {
      ready.push(
        applied.removed === 1
          ? "1 residuo de otra versión eliminado."
          : `${applied.removed} residuos de otra versión eliminados.`,
      );
    }
    ready.push(
      gaps.length === 0
        ? "Contrato AGENTIC_PROJECT_CONTRACT generado sin campos pendientes."
        : gaps.length === 1
          ? "Contrato AGENTIC_PROJECT_CONTRACT generado con 1 campo por completar."
          : `Contrato AGENTIC_PROJECT_CONTRACT generado con ${gaps.length} campos por completar.`,
    );
    ready.push(`Capa marcada como versión ${distributionVersion}.`);
  } else {
    ready.push("Plan completo calculado sin escrituras.");
  }

  if (codexInspection) {
    await applyCodexConfiguration(options, codexInspection, { ready, warnings, pending });
  }

  let codeGraph;
  if (options.codeGraphAction && !options.dryRun) {
    codeGraph = checkCommand("codegraph", [options.codeGraphAction, options.destination]);
    if (codeGraph.available) {
      ready.push(
        options.codeGraphAction === "init"
          ? "CodeGraph inicializado tras confirmación explícita."
          : "CodeGraph sincronizado tras confirmación explícita.",
      );
    }
  } else if (options.codeGraphAction) {
    codeGraph = checkCommand("codegraph", ["--version"]);
    if (codeGraph.available) ready.push("CodeGraph disponible; la mutación quedó solo en el plan.");
  } else {
    codeGraph = checkCommand("codegraph", ["status", "--json", options.destination]);
    if (codeGraph.available) {
      let status = null;
      try {
        status = JSON.parse(codeGraph.stdout);
      } catch {
        // Una versión anterior puede no producir JSON aunque acepte la consulta.
      }
      if (status?.initialized === false) {
        codeGraph = { ...codeGraph, available: false, detail: "índice no inicializado" };
      } else {
        ready.push("CodeGraph disponible y consultado sin modificarlo.");
        const pendingChanges = status?.pendingChanges;
        const hasPendingChanges =
          pendingChanges &&
          [pendingChanges.added, pendingChanges.modified, pendingChanges.removed].some(
            (count) => Number(count) > 0,
          );
        if (status?.index?.reindexRecommended || hasPendingChanges) {
          warnings.push("El índice de CodeGraph requiere sincronización o reconstrucción.");
          pending.push(
            "Revisar el estado de CodeGraph y usar --update-codegraph solo con confirmación explícita.",
          );
        }
      }
    }
  }
  if (!codeGraph.available) {
    missingRequirements.push({
      summary: `CodeGraph no está disponible o no tiene un índice válido (${codeGraph.detail}).`,
      action:
        "Instalar el ejecutable `codegraph`, dejarlo accesible en el PATH y crear el índice del repositorio con `codegraph init <destino>` o repitiendo esta adopción con --init-codegraph.",
    });
  }

  const engram = checkCommand("engram", ["version"]);
  if (engram.available) {
    ready.push("Ejecutable de Engram disponible.");
    pending.push(
      `Confirmar desde el host de agentes que Engram identifica ${basename(options.destination)} sin ambigüedad.`,
    );
  }
  else {
    missingRequirements.push({
      summary: `Engram no está disponible para la comprobación local (${engram.detail}).`,
      action:
        "Instalar el ejecutable `engram`, dejarlo accesible en el PATH y registrarlo en el host de agentes para que identifique este proyecto sin ambigüedad.",
    });
  }

  ready.push(
    `${adapterCounts.codex} adapters de Codex y ${adapterCounts.claude} de Claude validados.`,
  );
  ready.push("integridad estructural de la distribución validada.");
  if (targetIgnoresReady) ready.push("Exclusiones locales de CodeGraph y Engram validadas.");

  if (gaps.length) {
    pending.push(
      gaps.length === 1
        ? "Completar el campo pendiente del contrato con la skill `agentic-grilling`."
        : `Completar los ${gaps.length} campos pendientes del contrato con la skill \`agentic-grilling\`.`,
    );
  }

  if (missingRequirements.length) {
    console.log("\nREQUISITOS FALTANTES");
    for (const item of missingRequirements) {
      console.log(`- ${item.summary}`);
      console.log(`  ${item.action}`);
    }
    console.log(
      "  La capa queda instalada pero no puede orquestar: `.agents/policies/orquestacion.md`",
    );
    console.log(
      "  exige CodeGraph y Engram en el preflight y falla de forma cerrada sin ellos.",
    );
  }

  if (gaps.length) {
    console.log("\nCONTRATO POR COMPLETAR");
    for (const gap of gaps) {
      console.log(`- AGENTS.md, sección ${gap.section}, campo ${gap.label}`);
    }
    console.log(
      "  Completarlos en la primera sesión del agente con la skill `agentic-grilling`,",
    );
    console.log("  que es donde hay contexto y conversación para decidirlos.");
    console.log(
      "  Mientras queden marcados, la regla STRICT_PROJECT_CONTRACT_RULE de",
    );
    console.log(
      "  `.agents/policies/orquestacion.md` detiene cualquier tarea orquestada.",
    );
  }

  console.log("\nLISTO");
  for (const item of ready) console.log(`- ${item}`);
  console.log("\nADVERTENCIAS");
  if (warnings.length) for (const warning of warnings) console.log(`- ${warning}`);
  else console.log("- Ninguna.");
  console.log("\nACCIONES MANUALES PENDIENTES");
  if (pending.length) for (const item of pending) console.log(`- ${item}`);
  else console.log("- Ninguna.");

  return missingRequirements.length ? { exitCode: EXIT_REQUIREMENTS_MISSING } : { exitCode: 0 };
}

async function runCli(argv, invocation, operation = "init") {
  try {
    const options = parseArguments(argv, operation);
    if (options.help) {
      printHelp(invocation, operation);
      return;
    }
    if (options.version) {
      console.log(await readDistributionVersion());
      return;
    }
    const result = await run(options);
    if (result?.exitCode) process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2), "node scripts/agentic-init.mjs");
}

export {
  PACKAGE_FILES,
  TEMPLATE_FILES,
  isMissingContractValue,
  printHelp,
  readDistributionVersion,
  runCli,
};
