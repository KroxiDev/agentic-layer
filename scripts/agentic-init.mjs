#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, parse, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const CONTRACT_START = "<!-- AGENTIC_PROJECT_CONTRACT_START -->";
const CONTRACT_END = "<!-- AGENTIC_PROJECT_CONTRACT_END -->";
const GENERATED_CONTRACT_MARKER = "<!-- AGENTIC_PROJECT_CONTRACT_GENERATED -->";
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_FILES = [
  ".agents/README.md",
  ".agents/policies/orquestacion.md",
  ".agents/policies/sdd-tdd.md",
  ".agents/roles/documentador.md",
  ".agents/roles/evaluador.md",
  ".agents/roles/explorador.md",
  ".agents/roles/implementador.md",
  ".agents/roles/planificador.md",
  ".agents/roles/tester.md",
  ".agents/sessions/.gitignore",
  ".agents/skills/agentic-diagnostico-bugs/SKILL.md",
  ".agents/skills/agentic-diagnostico-bugs/references/hitl-loop.template.md",
  ".agents/skills/agentic-grilling/SKILL.md",
  ".agents/skills/agentic-tdd/SKILL.md",
  ".agents/skills/orquestar/SKILL.md",
  ".agents/templates/dev-session.md",
  ".agents/workflows/architecture.md",
  ".agents/workflows/bugfix.md",
  ".agents/workflows/feature.md",
  ".agents/workflows/refactor.md",
  ".codex/agents/documentador.toml",
  ".codex/agents/evaluador.toml",
  ".codex/agents/explorador.toml",
  ".codex/agents/implementador.toml",
  ".codex/agents/planificador.toml",
  ".codex/agents/tester.toml",
  ".claude/.gitignore",
  ".claude/agents/documentador.md",
  ".claude/agents/evaluador.md",
  ".claude/agents/explorador.md",
  ".claude/agents/implementador.md",
  ".claude/agents/planificador.md",
  ".claude/agents/tester.md",
  ".claude/skills/orquestar/SKILL.md",
  "CLAUDE.md",
];
const SUPPORT_FILES = [
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "scripts/agentic-init.mjs",
  "tests/agentic-init.test.mjs",
];

const IGNORED_SCAN_DIRECTORIES = new Set([
  ".agents",
  ".claude",
  ".codegraph",
  ".codex",
  ".engram",
  ".git",
  "node_modules",
]);

function parseArguments(argv) {
  const options = {
    destination: process.cwd(),
    dryRun: false,
    nonInteractive: false,
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
    } else if (argument === "--non-interactive") {
      options.nonInteractive = true;
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
  options.destination = resolve(options.destination);
  return options;
}

function printHelp() {
  console.log(`Uso: node scripts/agentic-init.mjs [destino] [opciones]

Opciones:
  --target <ruta>       Directorio destino; por defecto, el actual.
  --purpose <texto>     Propósito cuando no puede detectarse.
  --git-strategy <txt>  Estrategia Git cuando no está declarada.
  --dry-run             Muestra las acciones sin escribir.
  --non-interactive     No solicita datos por terminal.
  --init-codegraph      Confirma explícitamente inicializar CodeGraph.
  --update-codegraph    Confirma explícitamente sincronizar CodeGraph.
  -h, --help            Muestra esta ayuda.`);
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

async function readPackage(destination, warnings) {
  const packagePath = join(destination, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    return JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    warnings.push(`No se pudo interpretar package.json: ${error.message}`);
    return null;
  }
}

async function readOptionalText(destination, relativePath, warnings) {
  const absolutePath = join(destination, ...relativePath.split("/"));
  if (!existsSync(absolutePath)) return null;
  try {
    return await readFile(absolutePath, "utf8");
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

async function readReadmePurpose(destination, warnings) {
  const readmePath = join(destination, "README.md");
  if (!existsSync(readmePath)) return { purpose: null, title: null };
  try {
    const content = (await readFile(readmePath, "utf8")).replace(/^\uFEFF/, "");
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
    const blocks = content.split(/\r?\n\s*\r?\n/);
    for (const block of blocks) {
      const normalized = block.replace(/\r?\n/g, " ").trim();
      if (
        !normalized ||
        /^(#|```|~~~|<!--|\||[-*+]\s|\d+\.\s|!\[|\[!\[)/.test(normalized)
      ) {
        continue;
      }
      return {
        purpose: normalized
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/[*_`]/g, "")
          .trim(),
        title,
      };
    }
    return { purpose: null, title };
  } catch (error) {
    warnings.push(`No se pudo leer README.md: ${error.message}`);
    return { purpose: null, title: null };
  }
}

function quotePaths(paths) {
  return paths.map((path) => `\`${path}\``).join(", ");
}

async function detectProject(destination, warnings) {
  const [packageJson, readme, pyproject, cargo] = await Promise.all([
    readPackage(destination, warnings),
    readReadmePurpose(destination, warnings),
    readOptionalText(destination, "pyproject.toml", warnings),
    readOptionalText(destination, "Cargo.toml", warnings),
  ]);
  const files = await listProjectFiles(destination);
  const pythonProject = tomlSection(pyproject, "project") ?? tomlSection(pyproject, "tool.poetry");
  const cargoPackage = tomlSection(cargo, "package");
  const manifestPurpose =
    tomlString(pythonProject, "description") ?? tomlString(cargoPackage, "description");
  const purpose =
    typeof packageJson?.description === "string" && packageJson.description.trim()
      ? packageJson.description.replace(/\s+/g, " ").trim()
      : manifestPurpose ?? readme.purpose;

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

  let testFramework = "No aplica";
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
    purpose,
    purposeSource:
      typeof packageJson?.description === "string" && packageJson.description.trim()
        ? "package.json"
        : manifestPurpose
          ? pyproject
            ? "pyproject.toml"
            : "Cargo.toml"
          : readme.purpose
            ? "README.md"
            : null,
    readmeTitle: readme.title,
    architecture: projectTopLevels.length
      ? `componentes detectados en ${quotePaths(projectTopLevels)}.`
      : "No aplica: todavía no se detectó estructura de producto.",
    entrypoints: entrypoints.length
      ? [...new Set(entrypoints)]
          .map((entrypoint) => {
            const [command, target] = entrypoint.split(" → ");
            return target ? `\`${command}\` → \`${target}\`` : `\`${entrypoint}\``;
          })
          .join(", ")
      : "No aplica: no se detectaron entrypoints de producto.",
    focusedValidation: describeCommands(
      focusedCommands,
      "inspeccionar los archivos modificados y sus referencias directas.",
    ),
    completeValidation: describeCommands(
      completeCommands,
      "repetir la validación focalizada sobre todos los sectores afectados.",
    ),
    testFramework,
    testLocation: testLocations.length ? quotePaths(testLocations) : "No aplica",
    documentation: documentationLocations.length
      ? quotePaths(documentationLocations)
      : "No aplica",
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

function isMissingContractValue(value) {
  const normalized = value.trim();
  return (
    !normalized ||
    /<[^>]+>/.test(normalized) ||
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

function parseContractFields(source) {
  const start = source.indexOf(CONTRACT_START);
  const end = source.indexOf(CONTRACT_END);
  if (start < 0 || end < start) return new Map();
  const block = source.slice(start + CONTRACT_START.length, end);
  const fields = new Map();
  let activeKey = null;

  for (const line of block.split(/\r?\n/)) {
    const bullet = line.match(/^-\s+([^:]+):\s*(.*)$/);
    if (bullet) {
      activeKey = FIELD_ALIASES.get(normalizeLabel(bullet[1])) ?? null;
      if (activeKey && !isMissingContractValue(bullet[2])) {
        fields.set(activeKey, bullet[2].trim());
      }
      continue;
    }
    if (activeKey && /^\s{2,}\S/.test(line)) {
      const previous = fields.get(activeKey);
      if (previous) fields.set(activeKey, `${previous} ${line.trim()}`);
    } else if (line.trim()) {
      activeKey = null;
    }
  }

  return fields;
}

function contractValue(existingFields, key, fallback) {
  return existingFields.get(key) ?? fallback;
}

function renderContract(project, existingFields = new Map()) {
  const gitStrategy = contractValue(
    existingFields,
    "gitStrategy",
    project.gitStrategy,
  );

  return `${CONTRACT_START}
${GENERATED_CONTRACT_MARKER}

## Proyecto

- Propósito: ${contractValue(existingFields, "purpose", project.purpose)}
- Arquitectura: ${contractValue(existingFields, "architecture", project.architecture)}
- Entrypoints: ${contractValue(existingFields, "entrypoints", project.entrypoints)}

## Validación

- Focalizada: ${contractValue(existingFields, "focusedValidation", project.focusedValidation)}
- Completa: ${contractValue(existingFields, "completeValidation", project.completeValidation)}

## Tests

- Framework: ${contractValue(existingFields, "testFramework", project.testFramework)}
- Ubicación: ${contractValue(existingFields, "testLocation", project.testLocation)}
- Ciclo de vida: ${contractValue(existingFields, "testLifecycle", "conservar tests de regresión y retirar solo pruebas explícitamente temporales.")}

## Git

- Rama o estrategia permitida: ${gitStrategy}

## Seguridad

- Secretos: ${contractValue(existingFields, "secrets", "no almacenar credenciales; usar mecanismos externos o variables de entorno.")}
- Rutas protegidas: ${contractValue(existingFields, "protectedPaths", "`.git/`, `.codegraph/`, `.engram/` y archivos de secretos.")}
- Datos inmutables: ${contractValue(existingFields, "immutableData", "No aplica.")}
- Acciones restringidas: ${contractValue(existingFields, "restrictedActions", "no instalar herramientas, acceder a remotos, publicar paquetes ni modificar Git sin autorización explícita.")}
- Contaminación de origen: ${contractValue(existingFields, "originContamination", "No aplica; esta adopción parte de la plantilla canónica y no de una extracción manual de otro repositorio.")}

## Documentación

- README y documentación técnica: ${contractValue(existingFields, "documentation", `${project.documentation}; actualizar cuando cambien uso, arquitectura o validación.`)}
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

async function resolveRequiredFacts({ options, project, existingFields, baselineContract }) {
  const hasGit = existsSync(join(options.destination, ".git"));
  if (options.purpose) existingFields.set("purpose", options.purpose);
  if (options.gitStrategy) existingFields.set("gitStrategy", options.gitStrategy);

  let purpose = existingFields.get("purpose") ?? project.purpose;
  if (purpose && !isSafeContractFact(purpose)) purpose = null;
  if (
    baselineContract &&
    !options.purpose &&
    project.purposeSource === "README.md" &&
    normalizeLabel(project.readmeTitle ?? "") === "capa agentica reusable"
  ) {
    purpose = null;
  }

  let gitStrategy = existingFields.get("gitStrategy");
  if (gitStrategy && !isSafeContractFact(gitStrategy)) gitStrategy = null;
  if (!gitStrategy && !hasGit) {
    gitStrategy =
      "No aplica mientras el propietario no inicialice Git; el inicializador no lo crea ni lo modifica.";
  }

  const missing = [];
  if (!purpose) missing.push({ key: "purpose", flag: "--purpose", label: "Propósito del proyecto" });
  if (!gitStrategy) {
    missing.push({
      key: "gitStrategy",
      flag: "--git-strategy",
      label: "Rama o estrategia Git permitida",
    });
  }

  if (missing.length && (options.nonInteractive || !input.isTTY || !output.isTTY)) {
    throw new Error(
      `Faltan datos obligatorios que no pudieron descubrirse:\n${missing
        .map((item, index) => `${index + 1}. ${item.label}: usa ${item.flag} <texto>.`)
        .join("\n")}`,
    );
  }

  if (missing.length) {
    const readline = createInterface({ input, output });
    try {
      for (let index = 0; index < missing.length; index += 1) {
        const item = missing[index];
        let answer = "";
        while (!answer) {
          answer = (await readline.question(`${index + 1}. ${item.label}: `)).trim();
          if (answer && !isSafeContractFact(answer)) {
            output.write("El valor debe ocupar una sola línea y no contener marcadores contractuales.\n");
            answer = "";
          }
        }
        if (item.key === "purpose") purpose = answer;
        else gitStrategy = answer;
      }
    } finally {
      readline.close();
    }
  }

  existingFields.set("purpose", purpose);
  existingFields.set("gitStrategy", gitStrategy);
  project.purpose = purpose;
  project.gitStrategy = gitStrategy;
}

function replaceContract(source, contract) {
  const start = source.indexOf(CONTRACT_START);
  const end = source.indexOf(CONTRACT_END);
  if (start < 0 || end < start) {
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const separator = source.length === 0 ? "" : source.endsWith(eol) ? eol : `${eol}${eol}`;
    return `${source}${separator}${contract.replaceAll("\n", eol)}${eol}`;
  }
  return `${source.slice(0, start)}${contract}${source.slice(end + CONTRACT_END.length)}`;
}

async function planTemplateFiles(destination) {
  const actions = [];
  const collisions = [];

  for (const relativePath of TEMPLATE_FILES) {
    const sourcePath = join(SOURCE_ROOT, ...relativePath.split("/"));
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
      actions.push({ type: "copy", relativePath, sourcePath, destinationPath });
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
      actions.push({ type: "validate", relativePath });
    } else {
      collisions.push(relativePath);
    }
  }

  return { actions, collisions };
}

async function validateSubagentAdapters() {
  const roles = [
    "documentador",
    "evaluador",
    "explorador",
    "implementador",
    "planificador",
    "tester",
  ];
  const errors = [];

  for (const role of roles) {
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

  if (errors.length) {
    throw new Error(`Adapters de subagentes inválidos:\n${errors.map((item) => `- ${item}`).join("\n")}`);
  }
  return { codex: roles.length, claude: roles.length };
}

async function validateTemplateDistribution() {
  const errors = [];
  const roles = [
    "documentador",
    "evaluador",
    "explorador",
    "implementador",
    "planificador",
    "tester",
  ];

  if (new Set(TEMPLATE_FILES).size !== TEMPLATE_FILES.length) {
    errors.push("El inventario de distribución contiene rutas duplicadas.");
  }
  for (const relativePath of [...TEMPLATE_FILES, ...SUPPORT_FILES]) {
    const state = await pathState(join(SOURCE_ROOT, ...relativePath.split("/")));
    if (!state?.isFile() || state.isSymbolicLink()) {
      errors.push(`Falta un archivo regular de distribución: ${relativePath}.`);
    }
  }

  const sessions = await readdir(join(SOURCE_ROOT, ".agents", "sessions"));
  const unexpectedSessions = sessions.filter((name) => name !== ".gitignore");
  if (unexpectedSessions.length) {
    errors.push(
      `.agents/sessions contiene estado efímero distribuible: ${unexpectedSessions.join(", ")}.`,
    );
  }

  const [rootIgnore, sessionsIgnore, devSession, readme, rootAgents] = await Promise.all([
    readFile(join(SOURCE_ROOT, ".gitignore"), "utf8"),
    readFile(join(SOURCE_ROOT, ".agents", "sessions", ".gitignore"), "utf8"),
    readFile(join(SOURCE_ROOT, ".agents", "templates", "dev-session.md"), "utf8"),
    readFile(join(SOURCE_ROOT, "README.md"), "utf8"),
    readFile(join(SOURCE_ROOT, "AGENTS.md"), "utf8"),
  ]);
  for (const ignoredPath of [".codegraph/", ".engram/"]) {
    if (!rootIgnore.split(/\r?\n/).includes(ignoredPath)) {
      errors.push(`.gitignore no excluye ${ignoredPath}.`);
    }
  }
  if (!/^\*$/m.test(sessionsIgnore) || !/^!\.gitignore$/m.test(sessionsIgnore)) {
    errors.push(".agents/sessions/.gitignore no excluye todas las DevSession reales.");
  }
  if (!/^├── \.gitignore$/m.test(readme)) {
    errors.push("El árbol de README.md no documenta .gitignore.");
  }
  if (!/^- Contaminación de origen:/m.test(rootAgents)) {
    errors.push("El contrato raíz no declara Contaminación de origen.");
  }

  const devSessionFields = [
    "Objetivo:",
    "Workflow:",
    "Modo:",
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

  for (const role of roles) {
    const content = await readFile(join(SOURCE_ROOT, ".agents", "roles", `${role}.md`), "utf8");
    for (const heading of ["Entradas", "Proceso", "Salida", "Límites"]) {
      if (!new RegExp(`^## ${heading}$`, "m").test(content)) {
        errors.push(`.agents/roles/${role}.md no contiene la sección ${heading}.`);
      }
    }
  }

  const roleNames = new Set(roles.map((role) => normalizeLabel(role)));
  for (const workflow of ["architecture", "bugfix", "feature", "refactor"]) {
    const content = await readFile(
      join(SOURCE_ROOT, ".agents", "workflows", `${workflow}.md`),
      "utf8",
    );
    for (const match of content.matchAll(/—\s+([A-ZÁÉÍÓÚÑ][\p{L}-]+):/gu)) {
      if (!roleNames.has(normalizeLabel(match[1]))) {
        errors.push(`El workflow ${workflow} referencia un rol inexistente: ${match[1]}.`);
      }
    }
  }

  const markdownFiles = [
    "AGENTS.md",
    "README.md",
    ...TEMPLATE_FILES.filter((path) => path.endsWith(".md")),
  ];
  for (const relativePath of [...new Set(markdownFiles)]) {
    const absolutePath = join(SOURCE_ROOT, ...relativePath.split("/"));
    const content = await readFile(absolutePath, "utf8");
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, "");
      if (/^(?:[a-z]+:|#)/i.test(rawTarget)) continue;
      const fileTarget = rawTarget.split("#")[0];
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
  return { files: TEMPLATE_FILES.length + SUPPORT_FILES.length };
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
    stderr: result.stderr?.trim() ?? "",
  };
}

async function run(options) {
  assertSafeDestination(options.destination);
  const warnings = [];
  const pending = [];
  const ready = [];

  await access(SOURCE_ROOT, fsConstants.R_OK);
  await assertSafeDestinationAncestors(options.destination);
  const destinationState = await pathState(options.destination);
  if (destinationState && (!destinationState.isDirectory() || destinationState.isSymbolicLink())) {
    throw new Error("El destino debe ser un directorio real, no un archivo ni un enlace simbólico.");
  }

  const project = await detectProject(options.destination, warnings);
  const templatePlan = await planTemplateFiles(options.destination);
  if (templatePlan.collisions.length) {
    const error = new Error(
      `Colisiones detectadas; no se escribió ningún archivo:\n${templatePlan.collisions
        .map((path) => `- ${path}`)
        .join("\n")}`,
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
  const existingFields =
    destinationAgentsState && !baselineContract
      ? parseContractFields(currentAgents)
      : new Map();
  await resolveRequiredFacts({
    options,
    project,
    existingFields,
    baselineContract,
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
  const nextAgents = replaceContract(currentAgents, contract);
  const agentsAction = currentAgents === nextAgents ? "validate" : destinationAgentsState ? "update" : "create";

  console.log(options.dryRun ? "PLAN (sin escrituras)" : "ACCIONES");
  for (const action of templatePlan.actions) {
    console.log(`- ${action.type === "copy" ? "copiar" : "validar"}: ${action.relativePath}`);
  }
  console.log(`- ${agentsAction === "create" ? "crear" : agentsAction === "update" ? "actualizar" : "validar"}: AGENTS.md`);
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

  if (!options.dryRun) {
    const latestAgentsState = await pathState(destinationAgentsPath);
    if (Boolean(latestAgentsState) !== Boolean(destinationAgentsState)) {
      const error = new Error("AGENTS.md cambió después del preflight; no se escribió ningún archivo.");
      error.exitCode = 2;
      throw error;
    }
    if (destinationAgentsState) {
      const latestAgents = await readFile(destinationAgentsPath, "utf8");
      if (latestAgents !== currentAgents) {
        const error = new Error(
          "AGENTS.md cambió después del preflight; no se escribió ningún archivo.",
        );
        error.exitCode = 2;
        throw error;
      }
    }
    for (const action of templatePlan.actions) {
      if (action.type !== "copy") continue;
      if (await pathState(action.destinationPath)) {
        const error = new Error(
          `${action.relativePath} apareció después del preflight; no se escribió ningún archivo.`,
        );
        error.exitCode = 2;
        throw error;
      }
    }

    await mkdir(options.destination, { recursive: true });
    for (const action of templatePlan.actions) {
      if (action.type !== "copy") continue;
      await mkdir(dirname(action.destinationPath), { recursive: true });
      await copyFile(action.sourcePath, action.destinationPath, fsConstants.COPYFILE_EXCL);
    }
    if (agentsAction !== "validate") {
      await writeFile(destinationAgentsPath, nextAgents, {
        encoding: "utf8",
        flag: destinationAgentsState ? "w" : "wx",
      });
    }
    ready.push(`${templatePlan.actions.filter((action) => action.type === "copy").length} archivos de la capa copiados.`);
    ready.push("Contrato AGENTIC_PROJECT_CONTRACT generado.");
  } else {
    ready.push("Plan completo calculado sin escrituras.");
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
    warnings.push(
      `CodeGraph no está disponible o no tiene un índice válido (${codeGraph.detail}).`,
    );
    pending.push(
      options.codeGraphAction
        ? "Instalar o configurar CodeGraph fuera del inicializador y repetir la acción confirmada."
        : "Preparar CodeGraph localmente; usar --init-codegraph o --update-codegraph solo si se desea confirmar esa mutación.",
    );
  }

  const engram = checkCommand("engram", ["version"]);
  if (engram.available) {
    ready.push("Ejecutable de Engram disponible.");
    pending.push(
      `Confirmar desde el host de agentes que Engram identifica ${basename(options.destination)} sin ambigüedad.`,
    );
  }
  else {
    warnings.push(`Engram no está disponible para la comprobación local (${engram.detail}).`);
    pending.push("Configurar Engram en el host de agentes y confirmar la identidad del proyecto.");
  }

  ready.push(
    `${adapterCounts.codex} adapters de Codex y ${adapterCounts.claude} de Claude validados.`,
  );
  ready.push("integridad estructural de la distribución validada.");
  if (targetIgnoresReady) ready.push("Exclusiones locales de CodeGraph y Engram validadas.");

  console.log("\nLISTO");
  for (const item of ready) console.log(`- ${item}`);
  console.log("\nADVERTENCIAS");
  if (warnings.length) for (const warning of warnings) console.log(`- ${warning}`);
  else console.log("- Ninguna.");
  console.log("\nACCIONES MANUALES PENDIENTES");
  if (pending.length) for (const item of pending) console.log(`- ${item}`);
  else console.log("- Ninguna.");
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    await run(options);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { CONTRACT_END, CONTRACT_START, TEMPLATE_FILES, parseArguments, run };
