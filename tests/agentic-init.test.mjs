import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import {
  PACKAGE_FILES,
  TEMPLATE_FILES,
  isMissingContractValue,
} from "../scripts/agentic-init.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "agentic-init.mjs");
const BIN = join(ROOT, "bin", "agentic.mjs");
const SESSION_CONTROLLER = join(ROOT, ".agents", "scripts", "session-controller.mjs");
// Las simulaciones se ejecutan con un PATH vacío, así que toda adopción
// completa informa CodeGraph y Engram ausentes y sale con el código 4.
const SIN_HERRAMIENTAS = 4;
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createRepository(files = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agentic-init-test-"));
  temporaryDirectories.push(directory);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(directory, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  return directory;
}

async function snapshotDirectory(root) {
  const snapshot = new Map();

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        snapshot.set(
          absolutePath.slice(root.length + 1).replaceAll("\\", "/"),
          await readFile(absolutePath, "utf8"),
        );
      }
    }
  }

  await visit(root);
  return snapshot;
}

function runInitializer(directory, ...arguments_) {
  return spawnSync(
    process.execPath,
    [CLI, "--target", directory, "--non-interactive", ...arguments_],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    },
  );
}

// Sin banderas y sin TTY: exactamente el caso ideal de adopción con un solo
// comando, en el que el inicializador no puede preguntar nada.
function runInitializerWithoutFlags(directory) {
  return spawnSync(process.execPath, [CLI, "--target", directory], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
}

function countPendingFields(contract) {
  return contract.match(/<pendiente: [^>]+>/g)?.length ?? 0;
}

function runExecutable(...arguments_) {
  return spawnSync(process.execPath, [BIN, ...arguments_], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
}

function runSessionController(directory, command, options = {}, payload) {
  const arguments_ = [SESSION_CONTROLLER, command, "--root", directory, "--session", options.session];
  if (options.attempt) arguments_.push("--attempt", options.attempt);
  if (options.expectedRevision !== undefined) {
    arguments_.push("--expected-revision", String(options.expectedRevision));
  }
  return spawnSync(process.execPath, arguments_, {
    cwd: ROOT,
    encoding: "utf8",
    input: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

async function seedSessionContracts(repository) {
  const paths = [
    ".agents/templates/dev-session.md",
    ".agents/templates/subdev-session.md",
    ...["documentador", "evaluador", "explorador", "implementador", "planificador", "tester"].map(
      (role) => `.agents/roles/${role}.md`,
    ),
    ...["architecture", "bugfix", "feature", "refactor"].map(
      (workflow) => `.agents/workflows/${workflow}.md`,
    ),
  ];
  for (const relativePath of paths) {
    const source = join(ROOT, ...relativePath.split("/"));
    if (!existsSync(source)) continue;
    const target = join(repository, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(source, "utf8"), "utf8");
  }
}

async function createManagedSession(session) {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const initialized = runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    { workflow: "feature" },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  return {
    globalPath: join(repository, ".agents", "sessions", `${session}.md`),
    repository,
  };
}

async function createManagedAttempt(session, attempt) {
  const fixture = await createManagedSession(session);
  const opened = runSessionController(
    fixture.repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    { phaseId: "feature-implement", role: "implementador" },
  );
  assert.equal(opened.status, 0, opened.stderr);
  return {
    ...fixture,
    envelopePath: join(fixture.repository, ".agents", "sessions", session, `${attempt}.md`),
  };
}

function parseManagedState(source) {
  const match = source.match(
    /<!-- agentic-session:v1:start -->\n```json\n([\s\S]+?)\n```\n<!-- agentic-session:v1:end -->/,
  );
  assert.ok(match, "El artefacto debe contener un bloque administrado.");
  return JSON.parse(match[1]);
}

function controllerOutcome(result) {
  return result.status === 0
    ? { code: 0, error: "unexpected_success" }
    : { code: result.status, error: JSON.parse(result.stderr).error };
}

function controllerResponse(result) {
  return result.status === 0
    ? JSON.parse(result.stdout)
    : { failure: JSON.parse(result.stderr).error };
}

test("inicializa un repositorio nuevo a partir de hechos detectables", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify(
      {
        name: "catalogo-local",
        description: "Gestiona un catálogo local de productos.",
        main: "src/index.js",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
    "src/index.js": "export const catalogo = [];\n",
    "test/catalogo.test.js":
      'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("vacío", () => assert.ok(true));\n',
    "README.md": "# Catálogo local\n",
  });

  const result = runInitializer(repository);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.equal(existsSync(join(repository, ".agents", "README.md")), true);
  assert.equal(existsSync(join(repository, ".codex", "agents", "evaluador.toml")), true);
  assert.equal(existsSync(join(repository, ".claude", "agents", "evaluador.md")), true);
  assert.equal(existsSync(join(repository, "CLAUDE.md")), true);

  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.match(agents, /Propósito: Gestiona un catálogo local de productos\./);
  assert.match(agents, /Entrypoints: `src\/index\.js`/);
  assert.match(agents, /Framework: `node:test`/);
  assert.equal(
    agents.match(/AGENTIC_PROJECT_CONTRACT_START/g)?.length,
    1,
  );
  assert.match(result.stdout, /LISTO/);
});

test("añade el contrato a un AGENTS.md existente sin alterar sus instrucciones", async () => {
  const existingInstructions =
    "# Reglas del producto\r\n\r\n- No modificar datos importados.\r\n";
  const repository = await createRepository({
    "AGENTS.md": existingInstructions,
    "README.md":
      "# Conversor local\n\nConvierte documentos de texto mediante una interfaz local.\n",
    "src/main.py": "def main():\n    return 0\n",
  });

  const result = runInitializer(repository);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  const markerPosition = agents.indexOf("<!-- AGENTIC_PROJECT_CONTRACT_START -->");
  assert.notEqual(markerPosition, -1);
  assert.equal(agents.slice(0, existingInstructions.length), existingInstructions);
  assert.match(
    agents,
    /Propósito: Convierte documentos de texto mediante una interfaz local\./,
  );
});

test("completa un contrato parcial y conserva los valores explícitos", async () => {
  const prefix = "# Reglas existentes\n\nNo tocar la carpeta `imports/`.\n\n";
  const suffix = "\n\n## Regla posterior\n\nConservar esta sección.\n";
  const partialContract = `<!-- AGENTIC_PROJECT_CONTRACT_START -->

## Proyecto

- Propósito: Mantener informes internos sin acceder a servicios remotos.
- Arquitectura: <módulos relevantes>
- Entrypoints:

## Validación

- Focalizada: TODO

<!-- AGENTIC_PROJECT_CONTRACT_END -->`;
  const repository = await createRepository({
    "AGENTS.md": `${prefix}${partialContract}${suffix}`,
    "package.json": JSON.stringify({
      name: "informes",
      description: "Descripción detectada que no debe sustituir el valor explícito.",
      scripts: { test: "node --test" },
    }),
    "src/index.mjs": "export {};\n",
  });

  const result = runInitializer(repository);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.equal(agents.slice(0, prefix.length), prefix);
  assert.equal(agents.endsWith(suffix), true);
  assert.match(
    agents,
    /Propósito: Mantener informes internos sin acceder a servicios remotos\./,
  );
  assert.doesNotMatch(agents, /<módulos relevantes>|TODO/);
  assert.match(agents, /## Documentación/);
  assert.equal(agents.match(/AGENTIC_PROJECT_CONTRACT_START/g)?.length, 1);
});

test("detiene toda escritura cuando encuentra una colisión", async () => {
  const customCore = "# Núcleo propio que no pertenece a la plantilla\n";
  const repository = await createRepository({
    ".agents/README.md": customCore,
    "package.json": JSON.stringify({
      name: "repositorio-con-colision",
      description: "Ejercita la detección transaccional de colisiones.",
    }),
  });

  const result = runInitializer(repository);

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /Colisiones detectadas/);
  assert.match(result.stderr, /\.agents\/README\.md/);
  assert.equal(await readFile(join(repository, ".agents", "README.md"), "utf8"), customCore);
  assert.equal(existsSync(join(repository, "CLAUDE.md")), false);
  assert.equal(existsSync(join(repository, "AGENTS.md")), false);
});

test("una ejecución repetida no duplica ni altera contenido correcto", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "idempotente",
      description: "Demuestra que una segunda ejecución es estable.",
      scripts: { test: "node --test" },
    }),
    "src/index.mjs": "export const estable = true;\n",
  });

  const first = runInitializer(repository);
  assert.equal(first.status, SIN_HERRAMIENTAS, first.stderr || first.stdout);
  const before = await snapshotDirectory(repository);

  const second = runInitializer(repository);
  assert.equal(second.status, SIN_HERRAMIENTAS, second.stderr || second.stdout);
  const after = await snapshotDirectory(repository);

  assert.deepEqual(after, before);
  assert.doesNotMatch(second.stdout, /- copiar:/);
  const agents = after.get("AGENTS.md");
  assert.equal(agents.match(/AGENTIC_PROJECT_CONTRACT_START/g)?.length, 1);
  assert.equal(agents.match(/AGENTIC_PROJECT_CONTRACT_END/g)?.length, 1);
});

test("--dry-run muestra todas las acciones sin escribir", async () => {
  const repository = await createRepository({
    "README.md":
      "# Solo vista previa\n\nPermite comprobar el plan de adopción sin modificar archivos.\n",
  });
  const before = await snapshotDirectory(repository);

  const result = runInitializer(repository, "--dry-run");

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /PLAN \(sin escrituras\)/);
  assert.match(result.stdout, /copiar: \.agents\/README\.md/);
  assert.match(result.stdout, /crear: AGENTS\.md/);
  assert.match(result.stdout, /Plan completo calculado sin escrituras/);
  assert.deepEqual(await snapshotDirectory(repository), before);
});

test("CodeGraph o Engram ausentes instalan la capa pero reclaman los requisitos", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "sin-herramientas",
      description: "Funciona sin instalar dependencias o herramientas externas.",
    }),
  });

  const result = runInitializer(repository);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /REQUISITOS FALTANTES/);
  assert.match(result.stdout, /CodeGraph no está disponible/);
  assert.match(result.stdout, /Instalar el ejecutable `codegraph`/);
  assert.match(result.stdout, /Engram no está disponible/);
  assert.match(result.stdout, /Instalar el ejecutable `engram`/);
  assert.match(result.stdout, /no puede orquestar/);
  // El bloque de requisitos precede al resultado para que se lea primero.
  assert.ok(result.stdout.indexOf("REQUISITOS FALTANTES") < result.stdout.indexOf("\nLISTO"));
  assert.match(result.stdout, /ACCIONES MANUALES PENDIENTES/);
  assert.equal(existsSync(join(repository, "AGENTS.md")), true);
});

test("una capa preexistente divergente se reemplaza o se cancela, nunca en silencio", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "con-capa-previa",
      description: "Ya adoptó una versión anterior de la capa agéntica.",
    }),
  });

  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const version = await readFile(join(repository, ".agents", "VERSION"), "utf8");
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(version.trim(), manifest.version);

  const policy = join(repository, ".agents", "policies", "orquestacion.md");
  await writeFile(policy, "capa divergente de otra versión\n", "utf8");
  await mkdir(join(repository, ".agents", "skills", "agentic-viejo"), { recursive: true });
  await writeFile(
    join(repository, ".agents", "skills", "agentic-viejo", "SKILL.md"),
    "skill de una versión anterior\n",
    "utf8",
  );

  // Sin TTY no puede preguntarse: se detiene informando la capa y las opciones.
  const blocked = runInitializer(repository);
  assert.equal(blocked.status, 2, blocked.stdout);
  assert.match(blocked.stderr, /Se detectó una capa agéntica/);
  assert.match(blocked.stderr, /--force/);
  assert.equal(await readFile(policy, "utf8"), "capa divergente de otra versión\n");
  assert.equal(
    existsSync(join(repository, ".agents", "skills", "agentic-viejo", "SKILL.md")),
    true,
  );

  const replaced = runInitializer(repository, "--force");
  assert.equal(replaced.status, SIN_HERRAMIENTAS, replaced.stderr || replaced.stdout);
  assert.match(replaced.stdout, /detectada capa agéntica/);
  assert.match(replaced.stdout, /eliminar residuo de otra versión/);
  assert.equal(
    await readFile(policy, "utf8"),
    await readFile(join(ROOT, ".agents", "policies", "orquestacion.md"), "utf8"),
  );
  assert.equal(existsSync(join(repository, ".agents", "skills", "agentic-viejo")), false);
});

test("el reemplazo conserva las DevSessions y los archivos ajenos del proyecto", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "con-sesiones",
      description: "Conserva estado propio durante un reemplazo de la capa.",
    }),
  });

  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  await writeFile(
    join(repository, ".agents", "sessions", "tarea-en-curso.md"),
    "# DevSession real\n",
    "utf8",
  );
  await writeFile(join(repository, ".claude", "settings.local.json"), "{}\n", "utf8");
  await writeFile(
    join(repository, ".agents", "policies", "orquestacion.md"),
    "divergente\n",
    "utf8",
  );

  const replaced = runInitializer(repository, "--force");

  assert.equal(replaced.status, SIN_HERRAMIENTAS, replaced.stderr || replaced.stdout);
  assert.equal(
    await readFile(join(repository, ".agents", "sessions", "tarea-en-curso.md"), "utf8"),
    "# DevSession real\n",
  );
  assert.equal(existsSync(join(repository, ".claude", "settings.local.json")), true);
});

test("una colisión sin capa instalada no se trata como reemplazo", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "sin-capa",
      description: "Tiene archivos propios que colisionan con la distribución.",
    }),
    ".claude/agents/tester.md": "agente propio del proyecto\n",
  });

  const result = runInitializer(repository);

  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /Colisiones detectadas/);
  assert.doesNotMatch(result.stderr, /Se detectó una capa agéntica/);
  assert.equal(
    await readFile(join(repository, ".claude", "agents", "tester.md"), "utf8"),
    "agente propio del proyecto\n",
  );
});

test("un repositorio nuevo mínimo se adopta con un solo comando", async () => {
  const repository = await createRepository({
    ".git/HEAD": "ref: refs/heads/main\n",
    "README.md": "# proyecto\n",
  });

  const result = runInitializerWithoutFlags(repository);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /Faltan datos obligatorios/);
  assert.doesNotMatch(result.stderr, /--purpose/);
  assert.equal(existsSync(join(repository, "AGENTS.md")), true);
  assert.equal(existsSync(join(repository, "CLAUDE.md")), true);
  assert.equal(existsSync(join(repository, ".agents", "policies", "orquestacion.md")), true);
  assert.match(result.stdout, /LISTO/);
});

test("los campos no inferibles quedan marcados en el contrato y listados en la salida", async () => {
  const repository = await createRepository({
    ".git/HEAD": "ref: refs/heads/main\n",
    "notas.txt": "un repositorio sin metadatos declarados\n",
  });

  const result = runInitializerWithoutFlags(repository);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  const purpose = agents.match(/^- Propósito: (.*)$/m)?.[1];
  const gitStrategy = agents.match(/^- Rama o estrategia permitida: (.*)$/m)?.[1];
  assert.match(purpose, /^<pendiente: /);
  assert.match(gitStrategy, /^<pendiente: /);
  // El marcador solo sirve si la regla estricta del contrato lo cobra.
  assert.equal(isMissingContractValue(purpose), true);
  assert.equal(isMissingContractValue(gitStrategy), true);

  assert.match(result.stdout, /CONTRATO POR COMPLETAR/);
  assert.match(result.stdout, /- AGENTS\.md, sección Proyecto, campo Propósito/);
  assert.match(result.stdout, /- AGENTS\.md, sección Git, campo Rama o estrategia permitida/);
  assert.match(result.stdout, /agentic-grilling/);
  assert.match(result.stdout, /STRICT_PROJECT_CONTRACT_RULE/);
  assert.equal(
    countPendingFields(agents),
    result.stdout.match(/^- AGENTS\.md, sección /gm)?.length,
  );
});

test("un perfil de ecosistema conocido reduce los campos pendientes", async () => {
  const conMetadatos = await createRepository({
    "package.json": JSON.stringify({
      name: "perfil-node",
      description: "Declara metadatos reconocibles de su ecosistema.",
      main: "src/index.mjs",
    }),
    "src/index.mjs": "export const listo = true;\n",
  });
  const sinMetadatos = await createRepository({
    "notas.txt": "un repositorio sin metadatos declarados\n",
  });

  const conocido = runInitializerWithoutFlags(conMetadatos);
  const generico = runInitializerWithoutFlags(sinMetadatos);

  assert.equal(conocido.status, SIN_HERRAMIENTAS, conocido.stderr || conocido.stdout);
  assert.equal(generico.status, SIN_HERRAMIENTAS, generico.stderr || generico.stdout);
  const conPerfil = await readFile(join(conMetadatos, "AGENTS.md"), "utf8");
  const sinPerfil = await readFile(join(sinMetadatos, "AGENTS.md"), "utf8");

  assert.equal(countPendingFields(conPerfil), 0);
  assert.ok(
    countPendingFields(sinPerfil) > countPendingFields(conPerfil),
    "el repositorio sin metadatos debe conservar más campos pendientes",
  );
  assert.match(conPerfil, /Focalizada: ejecutar `node --check`/);
  assert.match(conPerfil, /Completa: ejecutar `node --test` sobre toda la suite\./);
  assert.match(conPerfil, /Framework: `node:test`/);
  assert.match(conPerfil, /Ubicación: `tests\/`/);
  assert.match(conPerfil, /README y documentación técnica: mantener `README\.md`/);
  assert.match(conocido.stdout, /sin campos pendientes/);
  assert.doesNotMatch(conocido.stdout, /CONTRATO POR COMPLETAR/);
});

test("una copia de plantilla marca los hechos propios y acepta declararlos por bandera", async () => {
  const [templateAgents, templateReadme] = await Promise.all([
    readFile(join(ROOT, "AGENTS.md"), "utf8"),
    readFile(join(ROOT, "README.md"), "utf8"),
  ]);
  const repository = await createRepository({
    ".git/HEAD": "ref: refs/heads/main\n",
    "AGENTS.md": templateAgents,
    "README.md": templateReadme,
  });

  const marked = runInitializer(repository);

  assert.equal(marked.status, SIN_HERRAMIENTAS, marked.stderr || marked.stdout);
  const pendingAgents = await readFile(join(repository, "AGENTS.md"), "utf8");
  // El propósito de la plantilla no puede heredarse como si fuera del proyecto.
  assert.match(pendingAgents, /^- Propósito: <pendiente: /m);
  assert.match(pendingAgents, /^- Rama o estrategia permitida: <pendiente: /m);
  assert.match(marked.stdout, /- AGENTS\.md, sección Proyecto, campo Propósito/);

  const initialized = runInitializer(
    repository,
    "--purpose",
    "Organiza notas de investigación locales.",
    "--git-strategy",
    "trabajar en ramas de tarea; no hacer push sin autorización.",
  );

  assert.equal(initialized.status, SIN_HERRAMIENTAS, initialized.stderr || initialized.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.match(agents, /Propósito: Organiza notas de investigación locales\./);
  assert.match(
    agents,
    /Rama o estrategia permitida: trabajar en ramas de tarea; no hacer push sin autorización\./,
  );
  assert.doesNotMatch(initialized.stdout, /campo Propósito/);
});

test("CodeGraph solo se inicializa o actualiza mediante confirmación explícita", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "codegraph-explicito",
      description: "Comprueba que las mutaciones opcionales requieren una bandera.",
    }),
  });

  const checkOnly = runInitializer(repository, "--dry-run");
  assert.equal(checkOnly.status, SIN_HERRAMIENTAS, checkOnly.stderr || checkOnly.stdout);
  assert.doesNotMatch(checkOnly.stdout, /inicializar CodeGraph|sincronizar CodeGraph/);

  const confirmed = runInitializer(repository, "--dry-run", "--init-codegraph");
  assert.equal(confirmed.status, SIN_HERRAMIENTAS, confirmed.stderr || confirmed.stdout);
  assert.match(confirmed.stdout, /inicializar CodeGraph \(confirmación explícita\)/);

  const ambiguous = runInitializer(
    repository,
    "--dry-run",
    "--init-codegraph",
    "--update-codegraph",
  );
  assert.equal(ambiguous.status, 1, ambiguous.stderr || ambiguous.stdout);
  assert.match(ambiguous.stderr, /no pueden combinarse/);
});

test("valida adapters equivalentes y mantiene al Evaluador de Claude en solo lectura", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "adapters-validos",
      description: "Comprueba los adapters nativos de subagentes.",
    }),
  });

  const result = runInitializer(repository);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const claudeEvaluator = await readFile(
    join(repository, ".claude", "agents", "evaluador.md"),
    "utf8",
  );
  const codexEvaluator = await readFile(
    join(repository, ".codex", "agents", "evaluador.toml"),
    "utf8",
  );
  assert.match(claudeEvaluator, /^permissionMode:\s*plan$/m);
  assert.match(claudeEvaluator, /^tools: (?!.*\b(?:Write|Edit)\b).*$/m);
  assert.match(codexEvaluator, /^sandbox_mode\s*=\s*"read-only"$/m);
  assert.match(result.stdout, /6 adapters de Codex y 6 de Claude validados/);
  assert.match(result.stdout, /integridad estructural de la distribución validada/);
});

test("detecta metadatos, comandos, tests y documentación fuera del ecosistema Node", async () => {
  const repository = await createRepository({
    "pyproject.toml": `[project]
name = "conversor"
description = "Convierte archivos locales a un formato normalizado."

[project.scripts]
conversor = "conversor.cli:main"

[tool.pytest.ini_options]
testpaths = ["tests"]
`,
    "src/conversor/cli.py": "def main():\n    return 0\n",
    "tests/test_cli.py": "def test_cli():\n    assert True\n",
    "docs/uso.md": "# Uso\n",
  });

  const result = runInitializer(repository);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.match(
    agents,
    /Propósito: Convierte archivos locales a un formato normalizado\./,
  );
  assert.match(agents, /Entrypoints: `conversor` → `conversor\.cli:main`/);
  assert.match(agents, /Framework: `pytest`/);
  assert.match(agents, /Completa: ejecutar `python -m pytest`/);
  assert.match(agents, /README y documentación técnica: `docs\/`/);
});

test("usa el directorio actual como destino predeterminado", async () => {
  const repository = await createRepository({
    "README.md":
      "# Destino actual\n\nInicializa el repositorio abierto sin exigir una ruta explícita.\n",
  });

  const result = spawnSync(process.execPath, [CLI, "--non-interactive"], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.equal(existsSync(join(repository, "AGENTS.md")), true);
  assert.equal(existsSync(join(repository, "CLAUDE.md")), true);
});

test("simula la adopción completa dentro de un directorio temporal", async () => {
  const repository = await createRepository({
    ".gitignore": ".codegraph/\n.engram/\n",
    "package.json": JSON.stringify({
      name: "adopcion-completa",
      description: "Representa una adopción local completa de la plantilla.",
      main: "src/index.mjs",
      scripts: { test: "node --test" },
    }),
    "src/index.mjs": "export const preparada = true;\n",
    "tests/smoke.test.mjs":
      'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("lista", () => assert.ok(true));\n',
  });
  const initial = await snapshotDirectory(repository);

  const preview = runInitializer(repository, "--dry-run");
  assert.equal(preview.status, SIN_HERRAMIENTAS, preview.stderr || preview.stdout);
  assert.deepEqual(await snapshotDirectory(repository), initial);

  const applied = runInitializer(repository);
  assert.equal(applied.status, SIN_HERRAMIENTAS, applied.stderr || applied.stdout);
  assert.match(applied.stdout, /integridad estructural de la distribución validada/);
  assert.match(applied.stdout, /Exclusiones locales de CodeGraph y Engram validadas/);
  const appliedSnapshot = await snapshotDirectory(repository);

  const repeated = runInitializer(repository);
  assert.equal(repeated.status, SIN_HERRAMIENTAS, repeated.stderr || repeated.stdout);
  assert.deepEqual(await snapshotDirectory(repository), appliedSnapshot);

  assert.deepEqual(
    await readdir(join(repository, ".agents", "sessions")),
    [".gitignore"],
  );
});

test("distribuye la Regla de Oro y conecta sus consumidores obligatorios", async () => {
  const policyReference = ".agents/policies/regla-de-oro.md";
  const globalActivation = `## Desarrollo

- Antes de agregar o modificar código o pruebas, leer y aplicar \`.agents/policies/regla-de-oro.md\`, tanto en tareas directas como orquestadas.`;
  const consumers = ["planificador", "implementador", "tester", "evaluador"];
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const rootAgents = await readFile(join(ROOT, "AGENTS.md"), "utf8");
  const orchestration = await readFile(
    join(ROOT, ".agents", "policies", "orquestacion.md"),
    "utf8",
  );
  const roleContents = await Promise.all(
    consumers.map((role) =>
      readFile(join(ROOT, ".agents", "roles", `${role}.md`), "utf8"),
    ),
  );

  assert.deepEqual(
    {
      policyPresent: existsSync(join(ROOT, ...policyReference.split("/"))),
      templateInventory: TEMPLATE_FILES.includes(policyReference),
      packageInventory: manifest.files.includes(policyReference),
      globalActivation: rootAgents.includes(globalActivation),
      consumersRegistered:
        orchestration.includes("Consumidores obligatorios") &&
        orchestration.includes(policyReference) &&
        consumers.every((role) =>
          orchestration.includes(role[0].toUpperCase() + role.slice(1)),
        ),
      roleReferences: Object.fromEntries(
        consumers.map((role, index) => [role, roleContents[index].includes(policyReference)]),
      ),
    },
    {
      policyPresent: true,
      templateInventory: true,
      packageInventory: true,
      globalActivation: true,
      consumersRegistered: true,
      roleReferences: {
        planificador: true,
        implementador: true,
        tester: true,
        evaluador: true,
      },
    },
  );
});

test("la fuente canónica valida su contrato base sin marcarlo como una adopción", () => {
  const result = runInitializer(ROOT, "--dry-run");

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /- validar: AGENTS\.md/);
  assert.doesNotMatch(result.stdout, /- actualizar: AGENTS\.md/);
});

test("detecta manifiestos escritos en UTF-8 con BOM por herramientas de Windows", async () => {
  const repository = await createRepository({
    "package.json": `﻿${JSON.stringify({
      name: "manifiesto-con-bom",
      description: "Se detecta aunque el manifiesto lleve marca de orden de bytes.",
    })}`,
    "pyproject.toml": '﻿[project]\ndescription = "No debe ganar sobre package.json."\n',
  });

  const result = runInitializer(repository);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /No se pudo interpretar package\.json/);
  assert.match(
    await readFile(join(repository, "AGENTS.md"), "utf8"),
    /Propósito: Se detecta aunque el manifiesto lleve marca de orden de bytes\./,
  );
});

test("el ejecutable `agentic` adopta la capa con el subcomando init", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "adopcion-por-cli",
      description: "Adopta la capa mediante el ejecutable distribuible.",
    }),
  });

  const result = runExecutable("init", repository, "--yes");

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.equal(existsSync(join(repository, "CLAUDE.md")), true);
  assert.equal(existsSync(join(repository, ".codex", "agents", "evaluador.toml")), true);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.match(agents, /Propósito: Adopta la capa mediante el ejecutable distribuible\./);
});

test("el ejecutable expone versión, ayuda y falla ante un subcomando inválido", async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

  const version = runExecutable("--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), manifest.version);

  const subcommandVersion = runExecutable("init", "--version");
  assert.equal(subcommandVersion.status, 0, subcommandVersion.stderr);
  assert.equal(subcommandVersion.stdout.trim(), manifest.version);

  const help = runExecutable("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /agentic init/);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--force/);

  const missing = runExecutable();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /falta un subcomando/i);

  const unknown = runExecutable("instalar", ".");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /subcomando desconocido/i);
});

test("--force reemplaza solo archivos canónicos divergentes", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "reemplazo-explicito",
      description: "Comprueba la semántica acotada de --force.",
    }),
  });

  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const canonical = join(repository, ".claude", "agents", "tester.md");
  const original = await readFile(canonical, "utf8");
  await writeFile(canonical, "# divergente\n", "utf8");
  await writeFile(join(repository, ".agents", "propio.md"), "# archivo del proyecto\n", "utf8");
  const agentsBefore = await readFile(join(repository, "AGENTS.md"), "utf8");

  const blocked = runInitializer(repository);
  assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
  assert.match(blocked.stderr, /\.claude\/agents\/tester\.md/);
  assert.match(blocked.stderr, /repetir con --force/);
  assert.equal(await readFile(canonical, "utf8"), "# divergente\n");

  const forced = runInitializer(repository, "--force");
  assert.equal(forced.status, SIN_HERRAMIENTAS, forced.stderr || forced.stdout);
  assert.match(forced.stdout, /- sobrescribir: \.claude\/agents\/tester\.md/);
  assert.match(forced.stdout, /1 archivo canónico divergente reemplazado/);
  assert.equal(await readFile(canonical, "utf8"), original);
  assert.equal(
    await readFile(join(repository, ".agents", "propio.md"), "utf8"),
    "# archivo del proyecto\n",
  );
  assert.equal(await readFile(join(repository, "AGENTS.md"), "utf8"), agentsBefore);
});

test("--force nunca reemplaza un directorio ni reescribe el seam AGENTS.md", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "limites-de-force",
      description: "Descripción detectada que no debe sustituir el hecho declarado.",
    }),
    "CLAUDE.md/marcador.txt": "un directorio ocupa la ruta canónica\n",
  });

  const blocked = runInitializer(repository, "--force");
  assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
  assert.match(blocked.stderr, /CLAUDE\.md/);
  assert.match(blocked.stderr, /--force no reemplaza enlaces simbólicos, directorios/);
  assert.equal(existsSync(join(repository, "AGENTS.md")), false);

  await rm(join(repository, "CLAUDE.md"), { recursive: true, force: true });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const declared = (await readFile(join(repository, "AGENTS.md"), "utf8")).replace(
    /- Propósito: .*/,
    "- Propósito: Hecho declarado por el propietario.",
  );
  await writeFile(join(repository, "AGENTS.md"), declared, "utf8");

  const forced = runInitializer(repository, "--force");
  assert.equal(forced.status, SIN_HERRAMIENTAS, forced.stderr || forced.stdout);
  assert.match(
    await readFile(join(repository, "AGENTS.md"), "utf8"),
    /- Propósito: Hecho declarado por el propietario\./,
  );
});

test("los assets de la distribución llegan al destino como archivos canónicos", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "assets-canonicos",
      description: "Restaura los nombres canónicos de los archivos ignorados.",
    }),
  });

  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

  assert.equal(
    await readFile(join(repository, ".agents", "sessions", ".gitignore"), "utf8"),
    "*\n!.gitignore\n",
  );
  assert.match(
    await readFile(join(repository, ".claude", ".gitignore"), "utf8"),
    /^\*\.local\.json$/m,
  );
  assert.equal(existsSync(join(repository, ".agents", "sessions", "gitignore.asset")), false);
  assert.equal(existsSync(join(repository, ".claude", "gitignore.asset")), false);
});

test("el manifiesto empaqueta el inventario canónico y excluye artefactos locales", async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

  assert.deepEqual([...manifest.files].sort(), [...PACKAGE_FILES].sort());
  assert.equal(manifest.bin.agentic, "./bin/agentic.mjs");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);

  for (const packaged of manifest.files) {
    assert.doesNotMatch(
      packaged,
      /(^|\/)\.(?:git|npm)ignore$/,
      `npm renombra ${packaged} al instalar; debe viajar como asset`,
    );
  }
  for (const excluded of [".codegraph", ".engram", "tests/", "node_modules"]) {
    assert.equal(
      manifest.files.some((path) => path.includes(excluded)),
      false,
      `el paquete no debe incluir ${excluded}`,
    );
  }
  for (const localConfiguration of manifest.files) {
    assert.doesNotMatch(localConfiguration, /\.local\.json$/);
    assert.doesNotMatch(localConfiguration, /^\.agents\/sessions\/(?!gitignore\.asset$)/);
  }
  assert.equal(
    TEMPLATE_FILES.every((path) => !path.startsWith("tests/") && !path.startsWith("scripts/")),
    true,
  );
});

test("session controller crea y adopta sesiones con identidad y contratos interpretables", async () => {
  const repository = await createRepository({
    ".agents/sessions/legacy.md": "# DevSession: legacy\n\nTexto humano conservado.\n",
  });
  await seedSessionContracts(repository);

  const legacyBefore = await readFile(join(repository, ".agents", "sessions", "legacy.md"), "utf8");
  const inspected = runSessionController(repository, "status", { session: "legacy" });
  const legacyAfterStatus = await readFile(
    join(repository, ".agents", "sessions", "legacy.md"),
    "utf8",
  );
  const adopted = runSessionController(
    repository,
    "init",
    { session: "legacy", expectedRevision: 0 },
    { workflow: "feature" },
  );
  const created = runSessionController(
    repository,
    "init",
    { session: "nueva", expectedRevision: 0 },
    { mode: "full", objective: "Comprobar el controlador.", workflow: "feature" },
  );
  const opened = runSessionController(
    repository,
    "open",
    {
      session: "nueva",
      attempt: "feature-explore--explorador--a01",
      expectedRevision: 1,
    },
    { phaseId: "feature-explore", role: "explorador" },
  );
  const contradictory = runSessionController(
    repository,
    "open",
    {
      session: "nueva",
      attempt: "feature-explore--tester--a02",
      expectedRevision: 2,
    },
    { phaseId: "feature-explore", role: "tester" },
  );
  const envelope = await readFile(
    join(
      repository,
      ".agents",
      "sessions",
      "nueva",
      "feature-explore--explorador--a01.md",
    ),
    "utf8",
  );
  const adoptedSource = await readFile(join(repository, ".agents", "sessions", "legacy.md"), "utf8");
  const createdSource = await readFile(join(repository, ".agents", "sessions", "nueva.md"), "utf8");

  assert.deepEqual(
    {
      adopted: JSON.parse(adopted.stdout),
      adoptedPreservesHuman: adoptedSource.startsWith(legacyBefore),
      contradictory: {
        code: contradictory.status,
        error: JSON.parse(contradictory.stderr).error,
      },
      created: JSON.parse(created.stdout),
      envelopeHasContract:
        envelope.includes("<!-- agentic-session:v1:start -->") &&
        envelope.includes("**Sector de importancia:**") &&
        envelope.includes("**Candidato a memoria:**"),
      globalHasManagedBlock: createdSource.includes("<!-- agentic-session:v1:start -->"),
      inspected: JSON.parse(inspected.stdout),
      legacyUnchangedByStatus: legacyAfterStatus === legacyBefore,
      opened: JSON.parse(opened.stdout),
    },
    {
      adopted: { command: "init", legacy: true, revision: 1, session: "legacy", state: "active" },
      adoptedPreservesHuman: true,
      contradictory: { code: 1, error: "attempt_identity_conflict" },
      created: { command: "init", legacy: false, revision: 1, session: "nueva", state: "active" },
      envelopeHasContract: true,
      globalHasManagedBlock: true,
      inspected: {
        attempts: [],
        classification: "recoverable",
        command: "status",
        legacy: true,
        revision: 0,
        session: "legacy",
        state: "active",
      },
      legacyUnchangedByStatus: true,
      opened: {
        attempt: "feature-explore--explorador--a01",
        command: "open",
        revision: 2,
        session: "nueva",
        state: "active",
      },
    },
  );
});

test("session controller reconoce y recupera un lock abandonado sin usar antigüedad", async () => {
  const session = "lock-abandonado";
  const attempt = "feature-implement--implementador--a01";
  const fixture = await createManagedSession(session);
  const lockPath = `${fixture.globalPath}.lock`;
  const owner = spawn(
    process.execPath,
    [
      "-e",
      [
        'const { writeFileSync } = require("node:fs");',
        "const lockPath = process.argv[1];",
        'writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "owner-real" }));',
        'process.stdout.write("ready\\n");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      lockPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const ownerExited = once(owner, "exit");

  try {
    await once(owner.stdout, "data");
    const activeStatus = runSessionController(fixture.repository, "status", { session });
    const blocked = runSessionController(
      fixture.repository,
      "open",
      { session, attempt, expectedRevision: 1 },
      { phaseId: "feature-implement", role: "implementador" },
    );

    owner.kill();
    await ownerExited;

    const abandonedStatus = runSessionController(fixture.repository, "status", { session });
    const recovered = runSessionController(fixture.repository, "recover", { session });
    const opened = runSessionController(
      fixture.repository,
      "open",
      { session, attempt, expectedRevision: 1 },
      { phaseId: "feature-implement", role: "implementador" },
    );

    assert.deepEqual(
      {
        abandonedStatus: JSON.parse(abandonedStatus.stdout),
        activeStatus: JSON.parse(activeStatus.stdout),
        blocked: { code: blocked.status, error: JSON.parse(blocked.stderr).error },
        lockRemoved: !existsSync(lockPath),
        opened: opened.stdout ? JSON.parse(opened.stdout) : { failure: opened.stderr },
        recovered: JSON.parse(recovered.stdout),
      },
      {
        abandonedStatus: {
          attempts: [],
          classification: "recoverable",
          command: "status",
          legacy: false,
          residues: [
            { classification: "recoverable", name: `${session}.md.lock`, state: "abandoned" },
          ],
          revision: 1,
          session,
          state: "active",
        },
        activeStatus: {
          attempts: [],
          classification: "recoverable",
          command: "status",
          legacy: false,
          residues: [
            { classification: "recoverable", name: `${session}.md.lock`, state: "active" },
          ],
          revision: 1,
          session,
          state: "active",
        },
        blocked: { code: 1, error: "session_locked" },
        lockRemoved: true,
        opened: { attempt, command: "open", revision: 2, session, state: "active" },
        recovered: {
          attempts: [],
          command: "recover",
          residues: [
            { classification: "recoverable", name: `${session}.md.lock`, state: "abandoned" },
          ],
          revision: 1,
          session,
        },
      },
    );
  } finally {
    if (owner.exitCode === null) {
      owner.kill();
      await ownerExited;
    }
  }
});

test("session controller publica el lock completo o deja solo un temporal no bloqueante", async () => {
  const session = "lock-publicacion-atomica";
  const attempt = "feature-implement--implementador--a01";
  const fixture = await createManagedSession(session);
  const sessionsPath = dirname(fixture.globalPath);
  const lockPath = `${fixture.globalPath}.lock`;
  let controller;
  let watcher;
  const acquisitionVisible = new Promise((resolvePromise, rejectPromise) => {
    watcher = watch(sessionsPath, (eventType, filename) => {
      const name = filename?.toString();
      if (name !== `${session}.md.lock` && !name?.startsWith(`${session}.md.tmp-lock-`)) return;
      watcher.close();
      controller.kill();
      resolvePromise(name);
    });
    watcher.on("error", rejectPromise);
  });
  controller = spawn(
    process.execPath,
    [
      SESSION_CONTROLLER,
      "open",
      "--root",
      fixture.repository,
      "--session",
      session,
      "--attempt",
      attempt,
      "--expected-revision",
      "1",
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const controllerExited = once(controller, "exit");
  controller.stdin.end(JSON.stringify({ phaseId: "feature-implement", role: "implementador" }));

  try {
    let acquisitionTimeout;
    const visibleName = await Promise.race([
      acquisitionVisible,
      new Promise((_, rejectPromise) => {
        acquisitionTimeout = setTimeout(
          () => rejectPromise(new Error("La adquisición no publicó ningún artefacto.")),
          5000,
        );
      }),
    ]);
    clearTimeout(acquisitionTimeout);
    await controllerExited;
    const status = runSessionController(fixture.repository, "status", { session });
    const recovered = runSessionController(fixture.repository, "recover", { session });
    const opened = runSessionController(
      fixture.repository,
      "open",
      { session, attempt, expectedRevision: 1 },
      { phaseId: "feature-implement", role: "implementador" },
    );
    const finalStatus = runSessionController(fixture.repository, "status", { session });

    assert.deepEqual(
      {
        finalLockAbsent: !existsSync(lockPath),
        finalResidues: JSON.parse(finalStatus.stdout).residues,
        opened: controllerResponse(opened),
        publishedPartialLock: visibleName === `${session}.md.lock` && existsSync(lockPath),
        recovered: JSON.parse(recovered.stdout).residues,
        status: JSON.parse(status.stdout).residues,
      },
      {
        finalLockAbsent: true,
        finalResidues: [],
        opened: { attempt, command: "open", revision: 2, session, state: "active" },
        publishedPartialLock: false,
        recovered: [{ classification: "recoverable", name: visibleName }],
        status: [{ classification: "recoverable", name: visibleName }],
      },
    );
  } finally {
    watcher?.close();
    if (controller.exitCode === null) {
      controller.kill();
      await controllerExited;
    }
  }
});

test("session controller exige y persiste la trazabilidad canónica de cada retrabajo", async () => {
  const session = "trazabilidad-retrabajo";
  const first = "feature-implement--implementador--a01";
  const second = "feature-implement--implementador--a02";
  async function failedFixture(suffix) {
    const fixture = await createManagedAttempt(`${session}-${suffix}`, first);
    const failed = runSessionController(
      fixture.repository,
      "fail",
      { session: `${session}-${suffix}`, attempt: first, expectedRevision: 2 },
      { cause: "El evaluador pidió cambios." },
    );
    assert.equal(failed.status, 0, failed.stderr);
    return { ...fixture, session: `${session}-${suffix}` };
  }

  const missingCause = await failedFixture("sin-causa");
  const withoutCause = runSessionController(
    missingCause.repository,
    "open",
    { session: missingCause.session, attempt: second, expectedRevision: 3 },
    { phaseId: "feature-implement", previousAttempt: first, role: "implementador" },
  );
  const missingPrevious = await failedFixture("sin-previo");
  const withoutPrevious = runSessionController(
    missingPrevious.repository,
    "open",
    { session: missingPrevious.session, attempt: second, expectedRevision: 3 },
    { cause: "Aplicar los cambios requeridos.", phaseId: "feature-implement", role: "implementador" },
  );
  const conflictingPrevious = await failedFixture("previo-invalido");
  const wrongPrevious = runSessionController(
    conflictingPrevious.repository,
    "open",
    { session: conflictingPrevious.session, attempt: second, expectedRevision: 3 },
    {
      cause: "Aplicar los cambios requeridos.",
      phaseId: "feature-implement",
      previousAttempt: "feature-implement--implementador--a00",
      role: "implementador",
    },
  );
  const fixture = await failedFixture("persistido");
  const cause = "Aplicar los cambios requeridos por el evaluador.";
  const opened = runSessionController(
    fixture.repository,
    "open",
    { session: fixture.session, attempt: second, expectedRevision: 3 },
    { cause, phaseId: "feature-implement", previousAttempt: first, role: "implementador" },
  );
  const globalManaged = parseManagedState(await readFile(fixture.globalPath, "utf8"));
  const envelopeSource = await readFile(
    join(fixture.repository, ".agents", "sessions", fixture.session, `${second}.md`),
    "utf8",
  );
  const envelopeManaged = parseManagedState(envelopeSource);

  assert.deepEqual(
    {
      envelopeContext:
        envelopeSource.includes(`- Intento anterior: \`${first}\``) &&
        envelopeSource.includes(`- Causa: ${cause}`),
      envelopeTrace: {
        cause: envelopeManaged.cause,
        previousAttempt: envelopeManaged.previousAttempt,
      },
      globalTrace: {
        cause: globalManaged.attempts[second].cause,
        previousAttempt: globalManaged.attempts[second].previousAttempt,
      },
      opened: opened.stdout ? JSON.parse(opened.stdout) : { failure: opened.stderr },
      withoutCause: controllerOutcome(withoutCause),
      withoutPrevious: controllerOutcome(withoutPrevious),
      wrongPrevious: controllerOutcome(wrongPrevious),
    },
    {
      envelopeContext: true,
      envelopeTrace: { cause, previousAttempt: first },
      globalTrace: { cause, previousAttempt: first },
      opened: {
        attempt: second,
        command: "open",
        revision: 4,
        session: fixture.session,
        state: "active",
      },
      withoutCause: { code: 2, error: "invalid_rework_cause" },
      withoutPrevious: { code: 2, error: "invalid_previous_attempt" },
      wrongPrevious: { code: 1, error: "previous_attempt_conflict" },
    },
  );
});

test("session controller reconcilia open si el sobre durable quedó fuera del ledger", async () => {
  const session = "checkpoint-open";
  const attempt = "feature-implement--implementador--a01";
  const fixture = await createManagedSession(session);
  const payload = {
    objective: "Conservar el sobre durable.",
    phaseId: "feature-implement",
    role: "implementador",
  };
  const globalBeforeOpen = await readFile(fixture.globalPath, "utf8");
  const opened = runSessionController(
    fixture.repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    payload,
  );
  assert.equal(opened.status, 0, opened.stderr);
  const envelopePath = join(
    fixture.repository,
    ".agents",
    "sessions",
    session,
    `${attempt}.md`,
  );
  const durableEnvelope = await readFile(envelopePath, "utf8");
  await writeFile(fixture.globalPath, globalBeforeOpen, "utf8");

  const divergent = runSessionController(
    fixture.repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    { ...payload, objective: "No reutilizar otro sobre." },
  );
  const retried = runSessionController(
    fixture.repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    payload,
  );
  const status = runSessionController(fixture.repository, "status", { session });
  const recovered = runSessionController(fixture.repository, "recover", { session });

  assert.deepEqual(
    {
      divergent: { code: divergent.status, error: JSON.parse(divergent.stderr).error },
      envelopePreserved: (await readFile(envelopePath, "utf8")) === durableEnvelope,
      recovered: JSON.parse(recovered.stdout),
      retried: retried.stdout ? JSON.parse(retried.stdout) : { failure: retried.stderr },
      status: JSON.parse(status.stdout),
    },
    {
      divergent: { code: 1, error: "attempt_collision" },
      envelopePreserved: true,
      recovered: {
        attempts: [{ attempt, classification: "recoverable", state: "active" }],
        command: "recover",
        residues: [],
        revision: 2,
        session,
      },
      retried: { attempt, command: "open", revision: 2, session, state: "active" },
      status: {
        attempts: [{ attempt, classification: "recoverable", state: "active" }],
        classification: "recoverable",
        command: "status",
        legacy: false,
        residues: [],
        revision: 2,
        session,
        state: "active",
      },
    },
  );
});

test("session controller reconcilia await-input si el sobre pausado precedió al ledger", async () => {
  const session = "checkpoint-await";
  const attempt = "feature-implement--implementador--a01";
  const fixture = await createManagedAttempt(session, attempt);
  const payload = { request: "Falta una decisión humana." };
  const globalBeforeAwait = await readFile(fixture.globalPath, "utf8");
  const waiting = runSessionController(
    fixture.repository,
    "await-input",
    { session, attempt, expectedRevision: 2 },
    payload,
  );
  assert.equal(waiting.status, 0, waiting.stderr);
  const durableEnvelope = await readFile(fixture.envelopePath, "utf8");
  await writeFile(fixture.globalPath, globalBeforeAwait, "utf8");

  const retried = runSessionController(
    fixture.repository,
    "await-input",
    { session, attempt, expectedRevision: 2 },
    payload,
  );
  const status = runSessionController(fixture.repository, "status", { session });
  const recovered = runSessionController(fixture.repository, "recover", { session });

  assert.deepEqual(
    {
      envelopePreserved: (await readFile(fixture.envelopePath, "utf8")) === durableEnvelope,
      recovered: JSON.parse(recovered.stdout),
      retried: retried.stdout ? JSON.parse(retried.stdout) : { failure: retried.stderr },
      status: JSON.parse(status.stdout),
    },
    {
      envelopePreserved: true,
      recovered: {
        attempts: [{ attempt, classification: "recoverable", state: "awaiting_input" }],
        command: "recover",
        residues: [],
        revision: 3,
        session,
      },
      retried: {
        attempt,
        command: "await-input",
        revision: 3,
        session,
        state: "awaiting_input",
      },
      status: {
        attempts: [{ attempt, classification: "recoverable", state: "awaiting_input" }],
        classification: "recoverable",
        command: "status",
        legacy: false,
        residues: [],
        revision: 3,
        session,
        state: "active",
      },
    },
  );
});

test("session controller reconcilia resume sin omitir el cambio humano obligatorio", async () => {
  const session = "checkpoint-resume";
  const attempt = "feature-implement--implementador--a01";
  const fixture = await createManagedAttempt(session, attempt);
  runSessionController(
    fixture.repository,
    "await-input",
    { session, attempt, expectedRevision: 2 },
    { request: "Falta una decisión humana." },
  );
  const unchangedPausedGlobal = await readFile(fixture.globalPath, "utf8");
  const changedPausedGlobal = unchangedPausedGlobal.replace(
    "\n<!-- agentic-session:v1:start -->",
    "\n- Respuesta humana registrada.\n\n<!-- agentic-session:v1:start -->",
  );
  await writeFile(fixture.globalPath, changedPausedGlobal, "utf8");
  const payload = { context: "La respuesta humana está registrada." };
  const resumed = runSessionController(
    fixture.repository,
    "resume",
    { session, attempt, expectedRevision: 3 },
    payload,
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  const durableEnvelope = await readFile(fixture.envelopePath, "utf8");

  await writeFile(fixture.globalPath, unchangedPausedGlobal, "utf8");
  const unchanged = runSessionController(
    fixture.repository,
    "resume",
    { session, attempt, expectedRevision: 3 },
    payload,
  );
  await writeFile(fixture.globalPath, changedPausedGlobal, "utf8");
  const retried = runSessionController(
    fixture.repository,
    "resume",
    { session, attempt, expectedRevision: 3 },
    payload,
  );
  const status = runSessionController(fixture.repository, "status", { session });
  const recovered = runSessionController(fixture.repository, "recover", { session });

  assert.deepEqual(
    {
      envelopePreserved: (await readFile(fixture.envelopePath, "utf8")) === durableEnvelope,
      recovered: JSON.parse(recovered.stdout),
      retried: retried.stdout ? JSON.parse(retried.stdout) : { failure: retried.stderr },
      status: JSON.parse(status.stdout),
      unchanged: { code: unchanged.status, error: JSON.parse(unchanged.stderr).error },
    },
    {
      envelopePreserved: true,
      recovered: {
        attempts: [{ attempt, classification: "recoverable", state: "active" }],
        command: "recover",
        residues: [],
        revision: 4,
        session,
      },
      retried: { attempt, command: "resume", revision: 4, session, state: "active" },
      status: {
        attempts: [{ attempt, classification: "recoverable", state: "active" }],
        classification: "recoverable",
        command: "status",
        legacy: false,
        residues: [],
        revision: 4,
        session,
        state: "active",
      },
      unchanged: { code: 1, error: "global_context_unchanged" },
    },
  );
});

test("session controller reconcilia fail si el ledger fallido precedió al sobre", async () => {
  const session = "checkpoint-fail";
  const attempt = "feature-implement--implementador--a01";
  const fixture = await createManagedAttempt(session, attempt);
  const payload = { cause: "El hilo se perdió antes del reporte." };
  const envelopeBeforeFail = await readFile(fixture.envelopePath, "utf8");
  const failed = runSessionController(
    fixture.repository,
    "fail",
    { session, attempt, expectedRevision: 2 },
    payload,
  );
  assert.equal(failed.status, 0, failed.stderr);
  await writeFile(fixture.envelopePath, envelopeBeforeFail, "utf8");

  const retried = runSessionController(
    fixture.repository,
    "fail",
    { session, attempt, expectedRevision: 3 },
    payload,
  );
  const global = await readFile(fixture.globalPath, "utf8");
  const status = runSessionController(fixture.repository, "status", { session });
  const recovered = runSessionController(fixture.repository, "recover", { session });

  assert.deepEqual(
    {
      consolidationCount:
        global.split("### Implementador feature-implement — intento 1, fallo sin reporte").length - 1,
      recovered: JSON.parse(recovered.stdout),
      retried: retried.stdout ? JSON.parse(retried.stdout) : { failure: retried.stderr },
      status: JSON.parse(status.stdout),
    },
    {
      consolidationCount: 1,
      recovered: {
        attempts: [{ attempt, classification: "safe_to_delete", state: "failed" }],
        command: "recover",
        residues: [],
        revision: 3,
        session,
      },
      retried: { attempt, command: "fail", revision: 3, session, state: "failed" },
      status: {
        attempts: [{ attempt, classification: "safe_to_delete", state: "failed" }],
        classification: "safe_to_delete",
        command: "status",
        legacy: false,
        residues: [],
        revision: 3,
        session,
        state: "active",
      },
    },
  );
});

test("session controller repite mutaciones exitosas solo con el mismo payload lógico", async () => {
  const attempt = "feature-implement--implementador--a01";

  const openFixture = await createManagedSession("idempotencia-open");
  const openPayload = {
    objective: "Ejecutar la tarea asignada.",
    phaseId: "feature-implement",
    role: "implementador",
  };
  const opened = runSessionController(
    openFixture.repository,
    "open",
    { session: "idempotencia-open", attempt, expectedRevision: 1 },
    openPayload,
  );
  const openRepeated = runSessionController(
    openFixture.repository,
    "open",
    { session: "idempotencia-open", attempt, expectedRevision: 2 },
    openPayload,
  );
  const openDivergent = runSessionController(
    openFixture.repository,
    "open",
    { session: "idempotencia-open", attempt, expectedRevision: 2 },
    { ...openPayload, objective: "Cambiar la tarea ya abierta." },
  );
  const nonMonotonic = runSessionController(
    openFixture.repository,
    "open",
    {
      session: "idempotencia-open",
      attempt: "feature-implement--implementador--a03",
      expectedRevision: 2,
    },
    {
      cause: "Saltar un intento.",
      phaseId: "feature-implement",
      previousAttempt: attempt,
      role: "implementador",
    },
  );

  const awaitFixture = await createManagedAttempt("idempotencia-await", attempt);
  const awaitPayload = { request: "Se requiere una decisión humana." };
  const awaited = runSessionController(
    awaitFixture.repository,
    "await-input",
    { session: "idempotencia-await", attempt, expectedRevision: 2 },
    awaitPayload,
  );
  const awaitRepeated = runSessionController(
    awaitFixture.repository,
    "await-input",
    { session: "idempotencia-await", attempt, expectedRevision: 3 },
    awaitPayload,
  );
  const awaitDivergent = runSessionController(
    awaitFixture.repository,
    "await-input",
    { session: "idempotencia-await", attempt, expectedRevision: 3 },
    { request: "Una pregunta diferente." },
  );

  const resumeFixture = await createManagedAttempt("idempotencia-resume", attempt);
  runSessionController(
    resumeFixture.repository,
    "await-input",
    { session: "idempotencia-resume", attempt, expectedRevision: 2 },
    awaitPayload,
  );
  await writeFile(
    resumeFixture.globalPath,
    (await readFile(resumeFixture.globalPath, "utf8")).replace(
      "\n<!-- agentic-session:v1:start -->",
      "\n- Respuesta humana persistida.\n\n<!-- agentic-session:v1:start -->",
    ),
    "utf8",
  );
  const resumePayload = { context: "La respuesta humana quedó registrada." };
  const resumed = runSessionController(
    resumeFixture.repository,
    "resume",
    { session: "idempotencia-resume", attempt, expectedRevision: 3 },
    resumePayload,
  );
  const resumeRepeated = runSessionController(
    resumeFixture.repository,
    "resume",
    { session: "idempotencia-resume", attempt, expectedRevision: 4 },
    resumePayload,
  );
  const resumeDivergent = runSessionController(
    resumeFixture.repository,
    "resume",
    { session: "idempotencia-resume", attempt, expectedRevision: 4 },
    { context: "Otro contexto." },
  );

  const failFixture = await createManagedAttempt("idempotencia-fail", attempt);
  const failPayload = { cause: "El hilo se perdió antes del reporte." };
  const failed = runSessionController(
    failFixture.repository,
    "fail",
    { session: "idempotencia-fail", attempt, expectedRevision: 2 },
    failPayload,
  );
  const failRepeated = runSessionController(
    failFixture.repository,
    "fail",
    { session: "idempotencia-fail", attempt, expectedRevision: 3 },
    failPayload,
  );
  const failDivergent = runSessionController(
    failFixture.repository,
    "fail",
    { session: "idempotencia-fail", attempt, expectedRevision: 3 },
    { cause: "Una causa distinta." },
  );

  assert.deepEqual(
    {
      awaitDivergent: controllerOutcome(awaitDivergent),
      awaitSame: controllerResponse(awaitRepeated),
      failDivergent: controllerOutcome(failDivergent),
      failSame: controllerResponse(failRepeated),
      nonMonotonic: controllerOutcome(nonMonotonic),
      openDivergent: controllerOutcome(openDivergent),
      openSame: controllerResponse(openRepeated),
      resumeDivergent: controllerOutcome(resumeDivergent),
      resumeSame: controllerResponse(resumeRepeated),
    },
    {
      awaitDivergent: { code: 1, error: "divergent_request" },
      awaitSame: JSON.parse(awaited.stdout),
      failDivergent: { code: 1, error: "divergent_failure" },
      failSame: JSON.parse(failed.stdout),
      nonMonotonic: { code: 1, error: "attempt_not_monotonic" },
      openDivergent: { code: 1, error: "divergent_open" },
      openSame: JSON.parse(opened.stdout),
      resumeDivergent: { code: 1, error: "divergent_resume" },
      resumeSame: JSON.parse(resumed.stdout),
    },
  );
});

test("session controller reanuda con contexto nuevo y consolida un reporte una sola vez", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "transaccion";
  const attempt = "feature-implement--implementador--a01";
  const report = [
    "- **Archivos modificados:** controlador y tests.",
    "- **Tareas completadas y pendientes:** completadas.",
    "- **Tests creados:** permanentes.",
    "- **Validación ejecutada:** verde.",
    "- **Desvíos o dudas:** No aplica.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    { workflow: "feature" },
  );
  runSessionController(
    repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    { phaseId: "feature-implement", role: "implementador" },
  );

  const globalPath = join(repository, ".agents", "sessions", `${session}.md`);
  await writeFile(`${globalPath}.lock`, JSON.stringify({ pid: process.pid }), "utf8");
  const concurrent = runSessionController(
    repository,
    "await-input",
    { session, attempt, expectedRevision: 2 },
    { request: "Operación concurrente." },
  );
  await rm(`${globalPath}.lock`);
  const stale = runSessionController(
    repository,
    "await-input",
    { session, attempt, expectedRevision: 1 },
    { request: "Falta una decisión." },
  );
  const waiting = runSessionController(
    repository,
    "await-input",
    { session, attempt, expectedRevision: 2 },
    { request: "Falta una decisión." },
  );
  await writeFile(
    globalPath,
    (await readFile(globalPath, "utf8")).replace(
      "## Próximos pasos\n\n- No aplica",
      "## Próximos pasos\n\n- Respuesta registrada por el orquestador.",
    ),
    "utf8",
  );
  const resumed = runSessionController(
    repository,
    "resume",
    { session, attempt, expectedRevision: 3 },
    { context: "La decisión ya está registrada." },
  );
  const incomplete = runSessionController(
    repository,
    "commit",
    { session, attempt, expectedRevision: 4 },
    { report: "- **Archivos modificados:** incompleto." },
  );
  const envelopePath = join(repository, ".agents", "sessions", session, `${attempt}.md`);
  const envelopeBeforeCommit = await readFile(envelopePath, "utf8");
  const committed = runSessionController(
    repository,
    "commit",
    { session, attempt, expectedRevision: 4 },
    { report },
  );
  await writeFile(envelopePath, envelopeBeforeCommit, "utf8");
  const interrupted = runSessionController(repository, "recover", { session });
  const idempotent = runSessionController(
    repository,
    "commit",
    { session, attempt, expectedRevision: 5 },
    { report },
  );
  const divergent = runSessionController(
    repository,
    "commit",
    { session, attempt, expectedRevision: 5 },
    { report: report.replace("verde.", "distinto.") },
  );
  const global = await readFile(globalPath, "utf8");
  const envelope = await readFile(
    envelopePath,
    "utf8",
  );
  const residues = (await readdir(join(repository, ".agents", "sessions"), {
    recursive: true,
  })).filter((path) => /\.(?:lock|tmp-)/.test(path));

  assert.deepEqual(
    {
      commit: committed.stdout ? JSON.parse(committed.stdout) : { failure: committed.stderr },
      consolidationCount: global.split(`### Implementador feature-implement — intento 1`).length - 1,
      concurrent: { code: concurrent.status, error: JSON.parse(concurrent.stderr).error },
      divergent: { code: divergent.status, error: JSON.parse(divergent.stderr).error },
      envelopeCompleted: envelope.includes('"state": "completed"'),
      idempotent: idempotent.stdout ? JSON.parse(idempotent.stdout) : { failure: idempotent.stderr },
      incomplete: { code: incomplete.status, error: JSON.parse(incomplete.stderr).error },
      interrupted: JSON.parse(interrupted.stdout).attempts,
      residues,
      resume: JSON.parse(resumed.stdout),
      stale: { code: stale.status, error: JSON.parse(stale.stderr).error },
      waiting: JSON.parse(waiting.stdout),
    },
    {
      commit: {
        ackHash: "10df6515652c05723cfe8c3038515f38689ec1d36bdd9a8f25318b608f161124",
        attempt,
        command: "commit",
        reportHash: "ef6d8e71012b24b5764aaed5f42e7342e679910d985e5cf605725b2bce8a274d",
        revision: 5,
        session,
        state: "completed",
      },
      consolidationCount: 1,
      concurrent: { code: 1, error: "session_locked" },
      divergent: { code: 1, error: "divergent_report" },
      envelopeCompleted: true,
      idempotent: {
        ackHash: "10df6515652c05723cfe8c3038515f38689ec1d36bdd9a8f25318b608f161124",
        attempt,
        command: "commit",
        idempotent: true,
        reportHash: "ef6d8e71012b24b5764aaed5f42e7342e679910d985e5cf605725b2bce8a274d",
        revision: 5,
        session,
        state: "completed",
      },
      incomplete: { code: 1, error: "incomplete_report" },
      interrupted: [{ attempt, classification: "recoverable", state: "completed" }],
      residues: [],
      resume: { attempt, command: "resume", revision: 4, session, state: "active" },
      stale: { code: 1, error: "stale_revision" },
      waiting: {
        attempt,
        command: "await-input",
        revision: 3,
        session,
        state: "awaiting_input",
      },
    },
  );
});

test("session controller recupera fallos, clasifica residuos y cierra solo sin pendientes", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "recuperacion";
  const first = "feature-test--tester--a01";
  const second = "feature-test--tester--a02";
  runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    { workflow: "feature" },
  );
  runSessionController(
    repository,
    "open",
    { session, attempt: first, expectedRevision: 1 },
    { phaseId: "feature-test", role: "tester" },
  );
  const premature = runSessionController(repository, "close", { session, expectedRevision: 2 });
  const failed = runSessionController(
    repository,
    "fail",
    { session, attempt: first, expectedRevision: 2 },
    { cause: "El hilo se perdió antes del reporte." },
  );
  const immutable = runSessionController(
    repository,
    "resume",
    { session, attempt: first, expectedRevision: 3 },
    { context: "No debe reactivarse." },
  );
  const retried = runSessionController(
    repository,
    "open",
    { session, attempt: second, expectedRevision: 3 },
    {
      cause: "Retrabajo tras fallo",
      phaseId: "feature-test",
      previousAttempt: first,
      role: "tester",
    },
  );
  runSessionController(
    repository,
    "fail",
    { session, attempt: second, expectedRevision: 4 },
    { cause: "Segundo fallo cerrado." },
  );

  const sessions = join(repository, ".agents", "sessions");
  await writeFile(join(sessions, `${session}.md.tmp-interrupted`), "parcial", "utf8");
  await writeFile(join(sessions, `${session}.unknown`), "sin identidad", "utf8");
  const recover = runSessionController(repository, "recover", { session });
  const ambiguousResiduePreserved = existsSync(join(sessions, `${session}.unknown`));
  const cleaned = runSessionController(repository, "cleanup", {
    session,
    expectedRevision: 5,
  });
  const blockedByResidues = runSessionController(repository, "close", {
    session,
    expectedRevision: 6,
  });
  await rm(join(sessions, `${session}.md.tmp-interrupted`));
  await rm(join(sessions, `${session}.unknown`));
  const closed = runSessionController(repository, "close", { session, expectedRevision: 6 });
  const finalStatus = runSessionController(repository, "status", { session });

  assert.deepEqual(
    {
      cleaned: cleaned.stdout ? JSON.parse(cleaned.stdout) : { failure: cleaned.stderr },
      closed: closed.stdout ? JSON.parse(closed.stdout) : { failure: closed.stderr },
      failed: JSON.parse(failed.stdout),
      finalStatus: {
        code: finalStatus.status,
        error: finalStatus.stderr ? JSON.parse(finalStatus.stderr).error : "unexpected_success",
      },
      immutable: { code: immutable.status, error: JSON.parse(immutable.stderr).error },
      premature: { code: premature.status, error: JSON.parse(premature.stderr).error },
      recover: JSON.parse(recover.stdout),
      retried: JSON.parse(retried.stdout),
      safeResidueDeleted: !existsSync(join(sessions, session)),
      ambiguousResiduePreserved,
      blockedByResidues: {
        code: blockedByResidues.status,
        error: JSON.parse(blockedByResidues.stderr).error,
      },
    },
    {
      cleaned: { command: "cleanup", deleted: [first, second], revision: 6, session },
      closed: { command: "close", deleted: true, session, state: "completed" },
      failed: { attempt: first, command: "fail", revision: 3, session, state: "failed" },
      finalStatus: { code: 1, error: "session_not_found" },
      immutable: { code: 1, error: "invalid_transition" },
      premature: { code: 1, error: "session_has_pending_attempts" },
      recover: {
        attempts: [
          { attempt: first, classification: "safe_to_delete", state: "failed" },
          { attempt: second, classification: "safe_to_delete", state: "failed" },
        ],
        command: "recover",
        residues: [
          { classification: "recoverable", name: `${session}.md.tmp-interrupted` },
          { classification: "ambiguous", name: `${session}.unknown` },
        ],
        revision: 5,
        session,
      },
      retried: { attempt: second, command: "open", revision: 4, session, state: "active" },
      safeResidueDeleted: true,
      ambiguousResiduePreserved: true,
      blockedByResidues: { code: 1, error: "session_has_residues" },
    },
  );
});

test("session controller conserva residuos de sobres interrumpidos y bloquea el cierre", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "residuo-sobre";
  const attempt = "feature-test--tester--a01";
  runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    { workflow: "feature" },
  );
  runSessionController(
    repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    { phaseId: "feature-test", role: "tester" },
  );
  runSessionController(
    repository,
    "fail",
    { session, attempt, expectedRevision: 2 },
    { cause: "Interrupción reproducida antes de renombrar el sobre." },
  );

  const envelopeResidue = join(
    repository,
    ".agents",
    "sessions",
    session,
    `${attempt}.md.tmp-interrupted`,
  );
  await writeFile(envelopeResidue, "escritura parcial", "utf8");
  const cleaned = runSessionController(repository, "cleanup", {
    session,
    expectedRevision: 3,
  });
  const status = runSessionController(repository, "status", { session });
  const closed = runSessionController(repository, "close", {
    session,
    expectedRevision: 4,
  });

  assert.deepEqual(
    {
      cleanup: JSON.parse(cleaned.stdout),
      close: {
        code: closed.status,
        error: closed.stderr ? JSON.parse(closed.stderr).error : "unexpected_success",
      },
      globalPreserved: existsSync(
        join(repository, ".agents", "sessions", `${session}.md`),
      ),
      residuePreserved: existsSync(envelopeResidue),
      status: JSON.parse(status.stdout).classification,
    },
    {
      cleanup: { command: "cleanup", deleted: [attempt], revision: 4, session },
      close: { code: 1, error: "session_has_residues" },
      globalPreserved: true,
      residuePreserved: true,
      status: "recoverable",
    },
  );
});

test("session controller se distribuye con contratos portables y excluye sesiones activas", async () => {
  const controllerPath = ".agents/scripts/session-controller.mjs";
  const subdevTemplatePath = ".agents/templates/subdev-session.md";
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const orchestration = await readFile(
    join(ROOT, ".agents", "policies", "orquestacion.md"),
    "utf8",
  );
  const skill = await readFile(join(ROOT, ".agents", "skills", "orquestar", "SKILL.md"), "utf8");
  const codex = await readFile(join(ROOT, ".codex", "agents", "implementador.toml"), "utf8");
  const claude = await readFile(join(ROOT, ".claude", "agents", "implementador.md"), "utf8");
  const activeSession = join(ROOT, ".agents", "sessions", "validacion-activa.md");
  await writeFile(activeSession, "# DevSession: validacion-activa\n", "utf8");
  try {
    const validation = runInitializer(ROOT, "--dry-run");
    const repository = await createRepository({
      "package.json": JSON.stringify({
        name: "adopcion-controlador",
        description: "Comprueba la distribución del controlador.",
      }),
    });
    const adoption = runInitializer(repository);

    assert.deepEqual(
      {
        adaptersPortable:
          codex.includes(controllerPath) &&
          claude.includes(controllerPath) &&
          !codex.includes("session-controller.py") &&
          !claude.includes("session-controller.py"),
        adopted:
          existsSync(join(repository, ...controllerPath.split("/"))) &&
          existsSync(join(repository, ...subdevTemplatePath.split("/"))),
        adoptionStatus: adoption.status,
        inventories: {
          manifest: [controllerPath, subdevTemplatePath].every((path) => manifest.files.includes(path)),
          package: [controllerPath, subdevTemplatePath].every((path) => PACKAGE_FILES.includes(path)),
          template: [controllerPath, subdevTemplatePath].every((path) => TEMPLATE_FILES.includes(path)),
        },
        orchestrationContract:
          orchestration.includes(controllerPath) &&
          orchestration.includes("init") &&
          orchestration.includes("commit") &&
          orchestration.includes("cleanup") &&
          skill.includes(controllerPath),
        packageExcludesSessions: manifest.files.every(
          (path) => !path.startsWith(".agents/sessions/") || path === ".agents/sessions/gitignore.asset",
        ),
        validation: { code: validation.status, stderr: validation.stderr },
      },
      {
        adaptersPortable: true,
        adopted: true,
        adoptionStatus: SIN_HERRAMIENTAS,
        inventories: { manifest: true, package: true, template: true },
        orchestrationContract: true,
        packageExcludesSessions: true,
        validation: { code: SIN_HERRAMIENTAS, stderr: "" },
      },
    );
  } finally {
    await rm(activeSession, { force: true });
  }
});
