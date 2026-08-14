import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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

function runExecutableWithEnvironment(environment, ...arguments_) {
  return spawnSync(process.execPath, [BIN, ...arguments_], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: "", ...environment },
  });
}

async function runInteractiveExecutableWithEnvironment(environment, answers, ...arguments_) {
  const child = spawn(process.execPath, [BIN, ...arguments_], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: "",
      AGENTIC_INIT_TEST_FORCE_TTY: "1",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let cursor = 0;
  let answerIndex = 0;
  const timeout = setTimeout(() => child.kill(), 15_000);

  function respond() {
    while (answerIndex < answers.length) {
      const transcript = `${stdout}\n${stderr}`;
      const pending = transcript.slice(cursor);
      const match = pending.match(answers[answerIndex].when);
      if (!match) return;
      cursor += match.index + match[0].length;
      const answer = `${answers[answerIndex].answer}\n`;
      answerIndex += 1;
      if (answerIndex === answers.length) child.stdin.end(answer);
      else child.stdin.write(answer);
    }
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    respond();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    respond();
  });
  const [status, signal] = await once(child, "close");
  clearTimeout(timeout);
  return { status, signal, stdout, stderr, answersSent: answerIndex };
}

function runInteractiveUpdate(repository, codexHome, answers, environment = {}) {
  return runInteractiveExecutableWithEnvironment(
    { CODEX_HOME: codexHome, ...environment },
    answers,
    "update",
    repository,
    "--codex-config",
    "none",
  );
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

function replaceManagedState(source, managed) {
  return source.replace(
    /<!-- agentic-session:v1:start -->\n```json\n[\s\S]+?\n```\n<!-- agentic-session:v1:end -->/,
    `<!-- agentic-session:v1:start -->\n\`\`\`json\n${JSON.stringify(managed, null, 2)}\n\`\`\`\n<!-- agentic-session:v1:end -->`,
  );
}

async function createPreTraceWorkUnitSession(session) {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const approvedPlan = {
    isolationCapacity: 1,
    mode: "full",
    platformCapacity: 6,
    readOnlyCapacity: 5,
    workUnits: [
      {
        acceptanceCriteria: ["C01"],
        dependsOn: [],
        ownedPaths: ["src/legacy.mjs"],
        permission: "writer",
        workUnitId: "unidad-legacy",
      },
    ],
    workflow: "feature",
    writerIsolationCapacity: 1,
  };
  const initialized = runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    approvedPlan,
  );
  assert.equal(initialized.status, 0, initialized.stderr);

  const globalPath = join(repository, ".agents", "sessions", `${session}.md`);
  const source = await readFile(globalPath, "utf8");
  const managed = parseManagedState(source);
  const preservedAttempt = "feature-implement--implementador--a01";
  managed.attempts = {
    [preservedAttempt]: {
      attempt: 1,
      evidence: { reportHash: "hash-evidencia" },
      failureCause: "fallo heredado",
      openPayloadHash: "hash-apertura",
      permission: "writer",
      phaseId: "feature-implement",
      reportHash: "hash-reporte",
      role: "implementador",
      state: "completed",
      workUnitId: "unidad-legacy",
    },
  };
  managed.currentPhase = "feature-implement";
  managed.evaluations = {
    standards: { attempt: "feature-evaluate--evaluador--a01", state: "changes_required" },
  };
  managed.revision = 30;
  Object.assign(managed.workUnits["unidad-legacy"], {
    consolidated: false,
    failureCause: "regresion heredada",
    impact: "impacto preservado",
    implementationAttempt: preservedAttempt,
    implementationEvidence: { reportHash: "hash-implementacion" },
    ownedPaths: ["SRC/Legacy.mjs. "],
    state: "implemented",
    validated: false,
  });
  delete managed.readOnlyCapacity;
  delete managed.writerIsolationCapacity;
  delete managed.evaluationGeneration;
  delete managed.evaluationRisk;
  delete managed.evaluationStrategy;
  delete managed.workUnits["unidad-legacy"].acceptanceCriteria;
  await writeFile(globalPath, replaceManagedState(source, managed), "utf8");
  return { approvedPlan, globalPath, repository, session };
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

test("agentic update se enruta y exige una capa existente antes de escribir", async () => {
  const repository = await createRepository({ "README.md": "# Proyecto sin capa\n" });
  const codexHome = await createRepository();
  const before = await snapshotDirectory(repository);

  const help = runExecutable("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /agentic update \[destino\]/);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /agentic init \[destino\]/);
  assert.deepEqual(await snapshotDirectory(repository), before);
});

test("update clasifica SemVer, bloquea una versión posterior y permite downgrade explícito", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "versiones-de-capa",
      description: "Comprueba la política SemVer del actualizador.",
    }),
  });
  const codexHome = await createRepository();
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  await writeFile(join(repository, ".agents", "VERSION"), "999.0.0\n", "utf8");
  const policy = join(repository, ".agents", "policies", "orquestacion.md");
  await writeFile(policy, "divergente\n", "utf8");

  const blocked = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );
  assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
  assert.match(blocked.stderr, /versión posterior|downgrade/i);
  assert.equal(await readFile(policy, "utf8"), "divergente\n");

  const allowed = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--allow-downgrade",
    "--codex-config",
    "none",
  );
  assert.equal(allowed.status, SIN_HERRAMIENTAS, allowed.stderr || allowed.stdout);
  assert.match(allowed.stdout, /posterior.*downgrade autorizado/i);
  assert.notEqual(await readFile(policy, "utf8"), "divergente\n");
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal((await readFile(join(repository, ".agents", "VERSION"), "utf8")).trim(), manifest.version);
});

test("update incorpora el inventario actual a una capa legacy y repara la misma versión", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "política legacy\n",
    "AGENTS.md": "# Reglas heredadas\r\n\r\nConservar esta prosa.\r\n",
    "README.md": "# Capa legacy\n\nProyecto con una capa anterior sin VERSION.\n",
  });
  const codexHome = await createRepository();

  const legacy = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );
  assert.equal(legacy.status, SIN_HERRAMIENTAS, legacy.stderr || legacy.stdout);
  assert.match(legacy.stdout, /legacy-sin-version/);
  assert.equal(existsSync(join(repository, ".agents", "skills", "agentic-tdd", "SKILL.md")), true);
  assert.match(await readFile(join(repository, "AGENTS.md"), "utf8"), /^# Reglas heredadas\r\n\r\nConservar esta prosa\.\r\n/);

  const missing = join(repository, ".claude", "agents", "tester.md");
  await rm(missing);
  const repaired = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );
  assert.equal(repaired.status, SIN_HERRAMIENTAS, repaired.stderr || repaired.stdout);
  assert.match(repaired.stdout, /igual/);
  assert.equal(existsSync(missing), true);
});

test("update anterior aplica residuos administrados y conserva DevSessions y archivos ajenos", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "actualización-anterior",
      description: "Comprueba reemplazo y límites de administración.",
    }),
  });
  const codexHome = await createRepository();
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  await writeFile(join(repository, ".agents", "VERSION"), "0.0.0\n", "utf8");
  await writeFile(
    join(repository, ".agents", "policies", "orquestacion.md"),
    "versión anterior\n",
    "utf8",
  );
  await mkdir(join(repository, ".agents", "skills", "retirada"), { recursive: true });
  await writeFile(
    join(repository, ".agents", "skills", "retirada", "SKILL.md"),
    "residuo administrado\n",
    "utf8",
  );
  await writeFile(
    join(repository, ".agents", "sessions", "tarea-en-curso.md"),
    "# DevSession real\n",
    "utf8",
  );
  await writeFile(join(repository, ".agents", "notas-locales.md"), "conservar\n", "utf8");
  await writeFile(join(repository, ".claude", "settings.local.json"), "{}\n", "utf8");

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /distribución actual.*\(anterior\)/i);
  assert.equal(
    await readFile(join(repository, ".agents", "policies", "orquestacion.md"), "utf8"),
    await readFile(join(ROOT, ".agents", "policies", "orquestacion.md"), "utf8"),
  );
  assert.equal(existsSync(join(repository, ".agents", "skills", "retirada")), false);
  assert.equal(
    await readFile(join(repository, ".agents", "sessions", "tarea-en-curso.md"), "utf8"),
    "# DevSession real\n",
  );
  assert.equal(await readFile(join(repository, ".agents", "notas-locales.md"), "utf8"), "conservar\n");
  assert.equal(await readFile(join(repository, ".claude", "settings.local.json"), "utf8"), "{}\n");
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal((await readFile(join(repository, ".agents", "VERSION"), "utf8")).trim(), manifest.version);
});

test("update migra aliases contractuales a IDs estables y conserva exterior y hechos", async () => {
  const prefix = "# Reglas del propietario\r\n\r\nNo tocar `datos/`.\r\n\r\n";
  const suffix = "\r\n\r\n## Regla posterior\r\n\r\nTambién se conserva.\r\n";
  const legacyContract = `<!-- AGENTIC_PROJECT_CONTRACT_START -->\r
\r
## Proyecto\r
\r
- Proposito: Procesar informes privados.\r
- Arquitectura: núcleo local y adapter CLI.\r
- Entrypoints: \`src/main.mjs\`.\r
\r
## Validación\r
\r
- Focalizada: ejecutar la prueba relacionada.\r
- Completa: ejecutar toda la suite.\r
\r
## Tests\r
\r
- Framework: \`node:test\`.\r
- Ubicacion: \`tests/\`.\r
- Ciclo de vida: conservar regresiones permanentes.\r
\r
## Git\r
\r
- Estrategia permitida: trabajar en main local.\r
\r
## Seguridad\r
\r
- Secretos: no almacenar secretos.\r
- Rutas protegidas: \`.git/\`.\r
- Datos inmutables: No aplica.\r
- Acciones restringidas: no publicar.\r
- Contaminacion de origen: No aplica; fuente propia.\r
\r
## Documentación\r
\r
- README y documentacion tecnica: mantener \`README.md\`.\r
- ADRs: usar \`docs/adr/\`.\r
\r
<!-- AGENTIC_PROJECT_CONTRACT_END -->`;
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `${prefix}${legacyContract}${suffix}`,
  });
  const codexHome = await createRepository();

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.equal(agents.startsWith(prefix), true);
  assert.equal(agents.endsWith(suffix), true);
  for (const fact of [
    "Propósito: Procesar informes privados.",
    "Arquitectura: núcleo local y adapter CLI.",
    "Entrypoints: `src/main.mjs`.",
    "Focalizada: ejecutar la prueba relacionada.",
    "Completa: ejecutar toda la suite.",
    "Framework: `node:test`.",
    "Ubicación: `tests/`.",
    "Ciclo de vida: conservar regresiones permanentes.",
    "Rama o estrategia permitida: trabajar en main local.",
    "Secretos: no almacenar secretos.",
    "Rutas protegidas: `.git/`.",
    "Datos inmutables: No aplica.",
    "Acciones restringidas: no publicar.",
    "Contaminación de origen: No aplica; fuente propia.",
    "README y documentación técnica: mantener `README.md`.",
    "ADRs: usar `docs/adr/`.",
  ]) {
    assert.ok(agents.includes(fact), `Debe preservar el hecho contractual: ${fact}`);
  }
  assert.equal(agents.match(/<!-- agentic-contract-field:v1 [a-z][A-Za-z]+ -->/g)?.length, 16);
  assert.equal(agents.replaceAll("\r\n", "").includes("\n"), false);
});

test("update reemplaza valores pendientes antiguos y agrega todos los campos contractuales nuevos", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "package.json": JSON.stringify({
      name: "contrato-pendiente",
      description: "Propósito detectado vigente.",
    }),
    "AGENTS.md": `# Reglas heredadas

<!-- AGENTIC_PROJECT_CONTRACT_START -->

## Proyecto

- Proposito: <pendiente: completar propósito>
- Arquitectura: arquitectura explícita conservada.

<!-- AGENTIC_PROJECT_CONTRACT_END -->
`,
  });
  const codexHome = await createRepository();

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.match(agents, /- Propósito: Propósito detectado vigente\./);
  assert.match(agents, /- Arquitectura: arquitectura explícita conservada\./);
  assert.equal(agents.match(/<!-- agentic-contract-field:v1 [a-z][A-Za-z]+ -->/g)?.length, 16);
  assert.doesNotMatch(agents, /completar propósito/);
});

test("update rechaza VERSION inválido antes de cualquier escritura", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    ".agents/VERSION": "1.02.3\n",
    "AGENTS.md": "# Reglas intactas\n",
  });
  const codexHome = await createRepository();
  const before = await snapshotDirectory(repository);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /SemVer válido/);
  assert.deepEqual(await snapshotDirectory(repository), before);
});

test("update preserva exactamente autolinks y valores contractuales legítimos con ángulos", async () => {
  const purpose = "<https://ejemplo.test/documentación?idioma=es>";
  const architecture = "Transforma <entrada> en <salida> mediante un pipeline local.";
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "package.json": JSON.stringify({
      name: "contrato-con-autolink",
      description: "Este fallback no debe sustituir hechos explícitos.",
    }),
    "AGENTS.md": `# Reglas heredadas

<!-- AGENTIC_PROJECT_CONTRACT_START -->

## Proyecto

- Propósito: ${purpose}
- Arquitectura: ${architecture}

<!-- AGENTIC_PROJECT_CONTRACT_END -->
`,
  });
  const codexHome = await createRepository();

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.equal(agents.match(/^- Propósito: (.*)$/m)?.[1], purpose);
  assert.equal(agents.match(/^- Arquitectura: (.*)$/m)?.[1], architecture);
});

test("update rechaza marcadores contractuales incompletos sin modificar el destino", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas intactas

<!-- AGENTIC_PROJECT_CONTRACT_START -->

## Proyecto

- Propósito: contrato truncado.
`,
  });
  const codexHome = await createRepository();
  const before = await snapshotDirectory(repository);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /marcadores contractuales incompletos o duplicados/i);
  assert.deepEqual(await snapshotDirectory(repository), before);
});

test("update no interactivo informa todas las formas no mapeables sin modificar el destino", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n- Campo retirado: valor que no puede perderse.\n  Su continuación también debe diagnosticarse.\n- Bullet histórico sin separador\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const before = await snapshotDirectory(repository);

  for (const flags of [["--yes"], ["--non-interactive"], [], ["--dry-run"]]) {
    const result = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--codex-config",
      "none",
      ...flags,
    );

    assert.equal(result.status, 2, `${flags.join(" ")}\n${result.stderr || result.stdout}`);
    assert.match(result.stderr, /Campo retirado/);
    assert.match(result.stderr, /continuación también debe diagnosticarse/);
    assert.match(result.stderr, /Bullet histórico sin separador/);
    assert.match(result.stderr, /mapear cada entrada.*conservarla.*eliminarla.*cancelar/is);
    assert.deepEqual(await snapshotDirectory(repository), before);
  }
});

test("update bloquea bullets de secciones contractuales históricas que no puede mapear", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n\n## Compatibilidad histórica\n\n- Garantía retirada sin separador\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const before = await snapshotDirectory(repository);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /Garantía retirada/);
  assert.match(result.stderr, /no mapeable/i);
  assert.deepEqual(await snapshotDirectory(repository), before);
});

test("update interactivo mapea una entrada a un campo canónico ausente", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n- Diseño retirado: módulos separados por adapters.\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const result = await runInteractiveUpdate(repository, codexHome, [
    { when: /Decisión \[1-4\]:/, answer: "1" },
    { when: /Campo \[1-16\]:/, answer: "2" },
    { when: /Aplicar estas acciones/, answer: "s" },
  ]);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.equal(result.answersSent, 3);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.match(
    agents,
    /<!-- agentic-contract-field:v1 architecture -->\r?\n- Arquitectura: módulos separados por adapters\./,
  );
  assert.doesNotMatch(agents, /Diseño retirado/);
});

test("update interactivo rechaza un destino ocupado y vuelve a decidir", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto ocupado.\n- Diseño retirado: arquitectura recuperada.\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const result = await runInteractiveUpdate(repository, codexHome, [
    { when: /Decisión \[1-4\]:/, answer: "1" },
    { when: /Campo \[1-16\]:/, answer: "1" },
    { when: /Decisión \[1-4\]:/, answer: "1" },
    { when: /Campo \[1-16\]:/, answer: "2" },
    { when: /Aplicar estas acciones/, answer: "s" },
  ]);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /Conflicto: Propósito \[purpose\] ya tiene valor/);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.match(agents, /- Propósito: Proyecto ocupado\./);
  assert.match(agents, /- Arquitectura: arquitectura recuperada\./);
});

test("update conserva el bullet y sus continuaciones fuera del contrato", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n- Garantía heredada: conservar el primer renglón.\n  Conservar también esta continuación.\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const result = await runInteractiveUpdate(repository, codexHome, [
    { when: /Decisión \[1-4\]:/, answer: "2" },
    { when: /Aplicar estas acciones/, answer: "s" },
  ]);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  const contract = agents.slice(
    agents.indexOf("<!-- AGENTIC_PROJECT_CONTRACT_START -->"),
    agents.indexOf("<!-- AGENTIC_PROJECT_CONTRACT_END -->"),
  );
  assert.doesNotMatch(contract, /Garantía heredada/);
  assert.match(
    agents,
    /## Reglas adicionales del proyecto\r?\n\r?\n- Garantía heredada: conservar el primer renglón\.\r?\n  Conservar también esta continuación\./,
  );
  assert.ok(
    agents.indexOf("## Reglas adicionales del proyecto") >
      agents.indexOf("<!-- AGENTIC_PROJECT_CONTRACT_END -->"),
  );
});

test("update reutiliza una sección existente de reglas adicionales", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n## Reglas adicionales del proyecto\n\n- Regla existente: conservar.\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n- Garantía heredada: mover sin duplicar encabezado.\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const result = await runInteractiveUpdate(repository, codexHome, [
    { when: /Decisión \[1-4\]:/, answer: "2" },
    { when: /Aplicar estas acciones/, answer: "s" },
  ]);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.equal(agents.match(/^## Reglas adicionales del proyecto$/gm)?.length, 1);
  assert.match(agents, /- Regla existente: conservar\./);
  assert.match(agents, /- Garantía heredada: mover sin duplicar encabezado\./);
  assert.ok(
    agents.indexOf("- Garantía heredada") <
      agents.indexOf("<!-- AGENTIC_PROJECT_CONTRACT_START -->"),
  );
});

test("update es idempotente después de conservar una regla adicional", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n- Garantía heredada: conservar una sola vez.\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const first = await runInteractiveUpdate(repository, codexHome, [
    { when: /Decisión \[1-4\]:/, answer: "2" },
    { when: /Aplicar estas acciones/, answer: "s" },
  ]);
  assert.equal(first.status, SIN_HERRAMIENTAS, first.stderr || first.stdout);
  const onceUpdated = await readFile(join(repository, "AGENTS.md"), "utf8");

  const second = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );
  assert.equal(second.status, SIN_HERRAMIENTAS, second.stderr || second.stdout);
  assert.equal(await readFile(join(repository, "AGENTS.md"), "utf8"), onceUpdated);
  assert.equal(onceUpdated.match(/Garantía heredada: conservar una sola vez/g)?.length, 1);
});

test("update elimina una entrada solo después de la confirmación explícita", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n- Regla obsoleta: información descartable.\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const result = await runInteractiveUpdate(repository, codexHome, [
    { when: /Decisión \[1-4\]:/, answer: "3" },
    { when: /Escriba ELIMINAR/, answer: "no" },
    { when: /Decisión \[1-4\]:/, answer: "3" },
    { when: /Escriba ELIMINAR/, answer: "ELIMINAR" },
    { when: /Aplicar estas acciones/, answer: "s" },
  ]);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /Eliminación no confirmada/);
  assert.doesNotMatch(await readFile(join(repository, "AGENTS.md"), "utf8"), /Regla obsoleta/);
});

test("cancelar la resolución contractual termina con salida 3 y cero escrituras", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n- Regla dudosa: debe sobrevivir a la cancelación.\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const before = await snapshotDirectory(repository);
  const result = await runInteractiveUpdate(repository, codexHome, [
    { when: /Decisión \[1-4\]:/, answer: "4" },
  ]);

  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(result.stderr, /Cancelado por el usuario/);
  assert.deepEqual(await snapshotDirectory(repository), before);
});

test("update resuelve varias entradas no mapeables en una misma ejecución", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n- Diseño retirado: arquitectura recuperada.\n  Incluye una continuación.\n- Compatibilidad histórica sin separador\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const result = await runInteractiveUpdate(repository, codexHome, [
    { when: /Decisión \[1-4\]:/, answer: "1" },
    { when: /Campo \[1-16\]:/, answer: "2" },
    { when: /Decisión \[1-4\]:/, answer: "2" },
    { when: /Aplicar estas acciones/, answer: "s" },
  ]);

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.match(
    agents,
    /- Arquitectura: arquitectura recuperada\. Incluye una continuación\./,
  );
  assert.match(agents, /## Reglas adicionales del proyecto[\s\S]*- Compatibilidad histórica sin separador/);
});

test("un fallo posterior a las decisiones restaura por completo la actualización", async () => {
  const repository = await createRepository({
    ".agents/policies/orquestacion.md": "legacy\n",
    "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n- Propósito: Proyecto legado.\n- Garantía heredada: el rollback debe restaurarla.\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
  });
  const codexHome = await createRepository();
  const before = await snapshotDirectory(repository);
  const result = await runInteractiveUpdate(
    repository,
    codexHome,
    [
      { when: /Decisión \[1-4\]:/, answer: "2" },
      { when: /Aplicar estas acciones/, answer: "s" },
    ],
    { AGENTIC_INIT_TEST_FAIL_AFTER: String(TEMPLATE_FILES.length + 1) },
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /restauración verificada/i);
  assert.deepEqual(await snapshotDirectory(repository), before);
});

test("update bloquea IDs o marcadores contractuales con versión o sintaxis desconocida", async () => {
  for (const marker of [
    "<!-- agentic-contract-field:v1 futureField -->",
    "<!-- agentic-contract-field:v2 purpose -->",
    "<!-- agentic-contract-field:v1 purpose extra -->",
  ]) {
    const repository = await createRepository({
      ".agents/policies/orquestacion.md": "legacy\n",
      "AGENTS.md": `# Reglas\n\n<!-- AGENTIC_PROJECT_CONTRACT_START -->\n\n## Proyecto\n\n${marker}\n- Propósito: Proyecto legado.\n\n<!-- AGENTIC_PROJECT_CONTRACT_END -->\n`,
    });
    const codexHome = await createRepository();
    const before = await snapshotDirectory(repository);

    const result = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--yes",
      "--codex-config",
      "none",
    );

    assert.equal(result.status, 2, `${marker}\n${result.stderr || result.stdout}`);
    assert.match(result.stderr, /(?:ID|marcador) contractual.*desconocid/i);
    assert.deepEqual(await snapshotDirectory(repository), before);
  }
});

test("update bloquea enlaces simbólicos residuales en directorios administrados", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "residuo-enlace", description: "Comprueba límites." }),
  });
  const codexHome = await createRepository();
  const external = await createRepository({ "SKILL.md": "contenido externo\n" });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const link = join(repository, ".agents", "skills", "enlace-ajeno");
  await symlink(external, link, process.platform === "win32" ? "junction" : "dir");

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /enlace simbólico/i);
  assert.equal(await readFile(join(external, "SKILL.md"), "utf8"), "contenido externo\n");
});

test("update dry-run enumera el plan y no escribe en capa ni configuración Codex", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "plan-seguro", description: "Prueba vista previa." }),
  });
  const codexHome = await createRepository({
    "config.toml": "# global\n[agents]\nmax_concurrent_threads_per_session = 3\n",
  });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  await writeFile(join(repository, ".agents", "policies", "orquestacion.md"), "divergente\n", "utf8");
  await mkdir(join(repository, ".agents", "skills", "retirada"), { recursive: true });
  await writeFile(join(repository, ".agents", "skills", "retirada", "SKILL.md"), "retirada\n", "utf8");
  const beforeProject = await snapshotDirectory(repository);
  const beforeGlobal = await snapshotDirectory(codexHome);

  const choices = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--dry-run",
  );
  assert.equal(choices.status, SIN_HERRAMIENTAS, choices.stderr || choices.stdout);
  assert.match(choices.stdout, /ofrecer global, local o none/i);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--dry-run",
    "--codex-config",
    "global",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /PLAN \(sin escrituras\)/);
  assert.match(result.stdout, /sobrescribir: \.agents\/policies\/orquestacion\.md/);
  assert.match(result.stdout, /eliminar residuo.*retirada\/SKILL\.md/);
  assert.match(result.stdout, /configuración global de Codex/i);
  assert.deepEqual(await snapshotDirectory(repository), beforeProject);
  assert.deepEqual(await snapshotDirectory(codexHome), beforeGlobal);
});

test("update sin confirmación general termina cancelado y no escribe", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "cancelación", description: "Prueba cancelación." }),
  });
  const codexHome = await createRepository();
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  await writeFile(join(repository, ".claude", "agents", "tester.md"), "divergente\n", "utf8");
  const before = await snapshotDirectory(repository);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(result.stderr, /Cancelado/);
  assert.deepEqual(await snapshotDirectory(repository), before);
});

test("un fallo intermedio de update restaura exactamente la capa y no actualiza VERSION", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "rollback", description: "Prueba recuperación." }),
  });
  const codexHome = await createRepository();
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  await writeFile(join(repository, ".agents", "VERSION"), "0.0.1\n", "utf8");
  await writeFile(join(repository, ".agents", "policies", "orquestacion.md"), "estado previo\n", "utf8");
  await rm(join(repository, ".claude", "agents", "tester.md"));
  await mkdir(join(repository, ".agents", "skills", "residuo"), { recursive: true });
  await writeFile(join(repository, ".agents", "skills", "residuo", "SKILL.md"), "previo\n", "utf8");
  const before = await snapshotDirectory(repository);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome, AGENTIC_INIT_TEST_FAIL_AFTER: "2" },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /restauración verificada/i);
  assert.deepEqual(await snapshotDirectory(repository), before);
  assert.equal((await readFile(join(repository, ".agents", "VERSION"), "utf8")).trim(), "0.0.1");
});

test("update aborta si un archivo aparece entre la revalidación global y su creación", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "carrera-creación", description: "Prueba carrera." }),
  });
  const codexHome = await createRepository();
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const racedPath = join(repository, ".agents", "README.md");
  await rm(racedPath);
  const previousVersion = await readFile(join(repository, ".agents", "VERSION"), "utf8");

  const result = runExecutableWithEnvironment(
    {
      CODEX_HOME: codexHome,
      AGENTIC_INIT_TEST_RACE_PATH: ".agents/README.md",
      AGENTIC_INIT_TEST_RACE_ACTION: "appear",
    },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /apareció después del plan/i);
  assert.equal(await readFile(racedPath, "utf8"), "contenido aparecido durante la aplicación\n");
  assert.equal(await readFile(join(repository, ".agents", "VERSION"), "utf8"), previousVersion);
});

test("update aborta si AGENTS.md es sustituido entre la revalidación global y su reemplazo", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "carrera-sustitución", description: "Prueba carrera." }),
  });
  const codexHome = await createRepository();
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const agentsPath = join(repository, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8");
  await writeFile(
    agentsPath,
    agents.replace("<!-- AGENTIC_PROJECT_CONTRACT_GENERATED -->\n", ""),
    "utf8",
  );
  const previousVersion = await readFile(join(repository, ".agents", "VERSION"), "utf8");

  const result = runExecutableWithEnvironment(
    {
      CODEX_HOME: codexHome,
      AGENTIC_INIT_TEST_RACE_PATH: "AGENTS.md",
      AGENTIC_INIT_TEST_RACE_ACTION: "replace",
    },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /AGENTS\.md cambió después del plan/i);
  assert.equal(await readFile(agentsPath, "utf8"), "contenido sustituido durante la aplicación\n");
  assert.equal(await readFile(join(repository, ".agents", "VERSION"), "utf8"), previousVersion);
});

test("un rollback incompleto conserva respaldos externos con un manifiesto recuperable", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "rollback-incompleto", description: "Prueba respaldo." }),
  });
  const codexHome = await createRepository();
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const target = join(repository, ".agents", "README.md");
  await writeFile(target, "estado recuperable\n", "utf8");

  const result = runExecutableWithEnvironment(
    {
      CODEX_HOME: codexHome,
      AGENTIC_INIT_TEST_FAIL_AFTER: "1",
      AGENTIC_INIT_TEST_FAIL_ROLLBACK_AFTER: "1",
    },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /restauración quedó incompleta/i);
  const backupMatch = result.stderr.match(/Respaldos recuperables conservados en: (.+)\r?$/m);
  assert.ok(backupMatch, result.stderr);
  const backupRoot = backupMatch[1].trim();
  temporaryDirectories.push(backupRoot);
  const manifest = JSON.parse(await readFile(join(backupRoot, "manifest.json"), "utf8"));
  const entry = manifest.find((item) => item.target === target);
  assert.ok(entry, JSON.stringify(manifest));
  assert.equal(await readFile(join(backupRoot, entry.backup), "utf8"), "estado recuperable\n");
});

test("rollback bloquea un padre sustituido por enlace y conserva respaldos sin escribir fuera", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "rollback-padre", description: "Prueba ancestros." }),
  });
  const codexHome = await createRepository();
  const external = await createRepository({ "sentinel.txt": "exterior intacto\n" });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  await writeFile(join(repository, ".agents", "VERSION"), "0.0.1\n", "utf8");
  await writeFile(join(repository, ".agents", "README.md"), "estado previo\n", "utf8");
  const externalBefore = await snapshotDirectory(external);

  const result = runExecutableWithEnvironment(
    {
      CODEX_HOME: codexHome,
      AGENTIC_INIT_TEST_FAIL_AFTER: "2",
      AGENTIC_INIT_TEST_ROLLBACK_RACE_PATH: ".agents/VERSION",
      AGENTIC_INIT_TEST_ROLLBACK_RACE_TARGET: external,
    },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "none",
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /restauración quedó incompleta/i);
  assert.match(result.stderr, /ancestro no seguro|enlace simbólico/i);
  const backupMatch = result.stderr.match(/Respaldos recuperables conservados en: (.+)\r?$/m);
  assert.ok(backupMatch, result.stderr);
  temporaryDirectories.push(backupMatch[1].trim());
  assert.deepEqual(await snapshotDirectory(external), externalBefore);

  const movedAgents = (await readdir(repository)).find((entry) =>
    entry.startsWith(".agents.agentic-rollback-original-"),
  );
  assert.ok(movedAgents, await readdir(repository));
  await unlink(join(repository, ".agents"));
  await rename(join(repository, movedAgents), join(repository, ".agents"));
});

test("Codex efectivo igual o superior a 12 no se pregunta, modifica ni reduce", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-listo", description: "Config suficiente." }),
    ".codex/config.toml": "[agents]\nmax_concurrent_threads_per_session = 12\n",
  });
  const codexHome = await createRepository({
    "config.toml": "[agents]\nmax_concurrent_threads_per_session = 3\n",
  });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const beforeLocal = await readFile(join(repository, ".codex", "config.toml"), "utf8");
  const beforeGlobal = await readFile(join(codexHome, "config.toml"), "utf8");

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "global",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /límite efectivo.*12.*no se modifica/i);
  assert.equal(await readFile(join(repository, ".codex", "config.toml"), "utf8"), beforeLocal);
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), beforeGlobal);
});

test("Codex considera desconocido el efectivo si la capa local o global es ambigua", async () => {
  const cases = [
    {
      name: "local-ambigua",
      local: "[agents]\nmax_threads = 3\n[agents]\nmax_threads = 4\n",
      global: "[agents]\nmax_concurrent_threads_per_session = 15\n",
    },
    {
      name: "global-ambigua",
      local: "[agents]\nmax_concurrent_threads_per_session = 12\n",
      global: "[agents]\nmax_threads = 3\n[agents]\nmax_threads = 4\n",
    },
  ];

  for (const fixture of cases) {
    const repository = await createRepository({
      "package.json": JSON.stringify({ name: fixture.name, description: "Prueba ambigüedad." }),
      ".codex/config.toml": fixture.local,
    });
    const codexHome = await createRepository({ "config.toml": fixture.global });
    assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

    const result = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--yes",
      "--codex-config",
      "local",
    );

    assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
    assert.match(result.stdout, /valor efectivo.*desconocido/i);
    assert.match(result.stdout, /edición manual/i);
    assert.doesNotMatch(result.stdout, /ya tiene un límite efectivo/i);
    assert.equal(await readFile(join(repository, ".codex", "config.toml"), "utf8"), fixture.local);
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), fixture.global);
  }
});

test("Codex global conserva BOM, EOL, comentarios y claves al actualizar solo la clave objetivo", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-global", description: "Edita global." }),
  });
  const original =
    "\uFEFF# configuración\r\nmodel = \"gpt\"\r\n\r\n[agents]\r\nmax_concurrent_threads_per_session = 4 # anterior\r\nfoo = true\r\n\r\n[otro]\r\nvalor = 1\r\n";
  const codexHome = await createRepository({ "config.toml": original });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "global",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.equal(
    await readFile(join(codexHome, "config.toml"), "utf8"),
    original.replace("= 4 # anterior", "= 12 # anterior"),
  );
  assert.equal(existsSync(join(repository, ".codex", "config.toml")), false);
});

test("Codex local crea o migra max_threads solo con autorización explícita", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-local", description: "Edita local." }),
  });
  const codexHome = await createRepository({
    "config.toml": "[agents]\nmax_threads = 5 # legacy\nmodel_reasoning_effort = \"high\"\n",
  });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

  const pending = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
  );
  assert.equal(pending.status, SIN_HERRAMIENTAS, pending.stderr || pending.stdout);
  assert.match(pending.stdout, /configuración de Codex.*pendiente/i);
  assert.equal(existsSync(join(repository, ".codex", "config.toml")), false);
  assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /max_threads = 5/);

  const local = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "local",
  );
  assert.equal(local.status, SIN_HERRAMIENTAS, local.stderr || local.stdout);
  assert.equal(
    await readFile(join(repository, ".codex", "config.toml"), "utf8"),
    "[agents]\nmax_concurrent_threads_per_session = 12\n",
  );

  await rm(join(repository, ".codex", "config.toml"));
  const global = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "global",
  );
  assert.equal(global.status, SIN_HERRAMIENTAS, global.stderr || global.stdout);
  assert.equal(
    await readFile(join(codexHome, "config.toml"), "utf8"),
    "[agents]\nmax_concurrent_threads_per_session = 12 # legacy\nmodel_reasoning_effort = \"high\"\n",
  );
});

test("Codex ambiguo queda manual y la precedencia local inferior no se oculta", async () => {
  const ambiguousRepository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-ambiguo", description: "TOML ambiguo." }),
    ".codex/config.toml": "[agents]\nmax_threads = 3\n[agents]\nmax_threads = 4\n",
  });
  const codexHome = await createRepository({
    "config.toml": "[agents]\nmax_concurrent_threads_per_session = 15\n",
  });
  assert.equal(runInitializer(ambiguousRepository).status, SIN_HERRAMIENTAS);
  const before = await readFile(join(ambiguousRepository, ".codex", "config.toml"), "utf8");

  const ambiguous = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    ambiguousRepository,
    "--yes",
    "--codex-config",
    "local",
  );
  assert.equal(ambiguous.status, SIN_HERRAMIENTAS, ambiguous.stderr || ambiguous.stdout);
  assert.match(ambiguous.stdout, /TOML ambiguo|edición manual/i);
  assert.equal(await readFile(join(ambiguousRepository, ".codex", "config.toml"), "utf8"), before);

  const precedenceRepository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-precedencia", description: "Precedencia local." }),
    ".codex/config.toml": "[agents]\nmax_concurrent_threads_per_session = 2\n",
  });
  assert.equal(runInitializer(precedenceRepository).status, SIN_HERRAMIENTAS);
  const precedence = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    precedenceRepository,
    "--yes",
    "--codex-config",
    "global",
  );
  assert.equal(precedence.status, SIN_HERRAMIENTAS, precedence.stderr || precedence.stdout);
  assert.match(precedence.stdout, /local.*precedencia.*seguirá usando.*2/i);
  assert.match(
    await readFile(join(precedenceRepository, ".codex", "config.toml"), "utf8"),
    /max_concurrent_threads_per_session = 2/,
  );
  assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /= 15/);
});

test("Codex deriva a edición manual toda definición agents o clave objetivo no soportada", async () => {
  const variants = [
    "agents = { max_concurrent_threads_per_session = 3 }\n",
    "[\"agents\"]\nmax_concurrent_threads_per_session = 3\n",
    "[[agents]]\nmax_concurrent_threads_per_session = 3\n",
    "[agents.worker]\nmax_concurrent_threads_per_session = 3\n",
    "agents.max_concurrent_threads_per_session = 3\n",
    "[agents]\n\"max_concurrent_threads_per_session\" = 3\n",
    "[agents]\n'max_threads' = 3\n",
  ];

  for (const source of variants) {
    const repository = await createRepository({
      "package.json": JSON.stringify({ name: "toml-conservador", description: "Prueba TOML." }),
      ".codex/config.toml": source,
    });
    const codexHome = await createRepository();
    assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

    const result = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--yes",
      "--codex-config",
      "local",
    );

    assert.equal(result.status, SIN_HERRAMIENTAS, `${source}\n${result.stderr || result.stdout}`);
    assert.match(result.stdout, /TOML ambigu|edición manual/i);
    assert.equal(await readFile(join(repository, ".codex", "config.toml"), "utf8"), source);
  }
});

test("Codex conserva byte a byte strings TOML multilínea con tablas y claves aparentes", async () => {
  const variants = [
    'mensaje = """\n[agents]\nmax_concurrent_threads_per_session = 2\n"""\n',
    "mensaje = '''\n[agents]\nmax_threads = 2\n'''\n",
  ];

  for (const source of variants) {
    const repository = await createRepository({
      "package.json": JSON.stringify({ name: "toml-multilinea", description: "Prueba léxica." }),
      ".codex/config.toml": source,
    });
    const codexHome = await createRepository();
    assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

    const result = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--yes",
      "--codex-config",
      "local",
    );

    assert.equal(result.status, SIN_HERRAMIENTAS, `${source}\n${result.stderr || result.stdout}`);
    assert.match(result.stdout, /TOML.*multilínea|edición manual/i);
    assert.equal(await readFile(join(repository, ".codex", "config.toml"), "utf8"), source);
  }
});

test("Codex local revalida ancestros no-follow justo antes de crear el temporal", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-carrera-local", description: "Prueba no-follow." }),
  });
  const codexHome = await createRepository();
  const external = await createRepository({ "sentinel.txt": "exterior intacto\n" });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const externalBefore = await snapshotDirectory(external);

  const result = runExecutableWithEnvironment(
    {
      CODEX_HOME: codexHome,
      AGENTIC_INIT_TEST_CODEX_RACE_STAGE: "before-temporary",
      AGENTIC_INIT_TEST_CODEX_RACE_TARGET: external,
    },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "local",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /enlace simbólico no seguro|ancestro no seguro/i);
  assert.match(result.stdout, /Editar manualmente .*config\.toml/i);
  assert.deepEqual(await snapshotDirectory(external), externalBefore);
});

test("Codex global revalida ancestros no-follow justo antes de la mutación final", async () => {
  const container = await createRepository();
  const codexHome = join(container, "codex-home");
  const external = join(container, "external");
  await mkdir(codexHome);
  await mkdir(external);
  await writeFile(join(external, "sentinel.txt"), "exterior intacto\n", "utf8");
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-carrera-global", description: "Prueba no-follow." }),
  });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const externalBefore = await snapshotDirectory(external);

  const result = runExecutableWithEnvironment(
    {
      CODEX_HOME: codexHome,
      AGENTIC_INIT_TEST_CODEX_RACE_STAGE: "before-mutation",
      AGENTIC_INIT_TEST_CODEX_RACE_TARGET: external,
    },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "global",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /enlace simbólico no seguro|ancestro no seguro/i);
  assert.match(result.stdout, /Editar manualmente .*config\.toml/i);
  assert.deepEqual(await snapshotDirectory(external), externalBefore);
});

test("Codex delimita agents ante tablas-array y conserva sus claves objetivo byte a byte", async () => {
  const source =
    "[agents]\r\nfoo = true\r\n\r\n[[workers]]\r\nmax_concurrent_threads_per_session = 3 # worker\r\nmax_threads = 4 # legacy worker\r\n";
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "toml-array", description: "Prueba límite TOML." }),
    ".codex/config.toml": source,
  });
  const codexHome = await createRepository();
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "local",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.equal(
    await readFile(join(repository, ".codex", "config.toml"), "utf8"),
    source.replace("foo = true\r\n", "max_concurrent_threads_per_session = 12\r\nfoo = true\r\n"),
  );
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

test("session controller interpreta el contrato de rol hasta EOF aunque contenga z", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  await writeFile(
    join(repository, ".agents", "roles", "explorador.md"),
    "# Rol: Explorador\n\n## Salida\n\n- **Hallazgo z:** resultado.\n",
    "utf8",
  );
  const session = "contrato-hasta-eof";
  const attempt = "feature-explore--explorador--a01";

  const initialized = runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    { workflow: "feature" },
  );
  const opened = runSessionController(
    repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    { phaseId: "feature-explore", role: "explorador" },
  );

  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(opened.status, 0, opened.stderr);
  const envelope = parseManagedState(
    await readFile(
      join(repository, ".agents", "sessions", session, `${attempt}.md`),
      "utf8",
    ),
  );
  assert.deepEqual(envelope.contract, ["Hallazgo z"]);
});

test("session controller separa la unidad del intento y conserva sesiones v1", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "identidad-unidad";
  const attempt = "feature-implement--implementador--a01";
  const workUnit = {
    acceptanceCriteria: ["C01"],
    dependsOn: [],
    ownedPaths: ["scripts/tarea.mjs"],
    permission: "writer",
    workUnitId: "unidad-principal",
  };

  const initialized = runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    {
      isolationCapacity: 1,
      mode: "full",
      platformCapacity: 6,
      workUnits: [workUnit],
      workflow: "feature",
    },
  );
  const opened = runSessionController(
    repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    {
      baseRevision: "31bfee4",
      criteria: ["C01"],
      phaseId: "feature-implement",
      permission: "writer",
      role: "implementador",
      threadId: "thread-implementador-1",
      workUnitId: workUnit.workUnitId,
    },
  );

  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(opened.status, 0, opened.stderr);
  const global = parseManagedState(
    await readFile(join(repository, ".agents", "sessions", `${session}.md`), "utf8"),
  );
  const envelope = parseManagedState(
    await readFile(
      join(repository, ".agents", "sessions", session, `${attempt}.md`),
      "utf8",
    ),
  );
  assert.equal(global.attempts[attempt].workUnitId, workUnit.workUnitId);
  assert.equal(global.currentPhase, "feature-implement");
  assert.deepEqual(
    {
      baseRevision: global.attempts[attempt].baseRevision,
      criteria: global.attempts[attempt].criteria,
      permission: global.attempts[attempt].permission,
      threadId: global.attempts[attempt].threadId,
      wave: global.attempts[attempt].wave,
    },
    {
      baseRevision: "31bfee4",
      criteria: ["C01"],
      permission: "writer",
      threadId: "thread-implementador-1",
      wave: 1,
    },
  );
  assert.equal(envelope.workUnitId, workUnit.workUnitId);
  assert.equal(envelope.baseRevision, "31bfee4");
  assert.equal(envelope.threadId, "thread-implementador-1");
  assert.deepEqual(global.workUnits[workUnit.workUnitId], {
    ...workUnit,
    implementationAttempt: attempt,
    state: "active",
    wave: 1,
  });

  for (const [name, omitted, error] of [
    ["sin-revision", "baseRevision", "base_revision_required"],
    ["sin-hilo", "threadId", "thread_id_required"],
  ]) {
    const missing = await createRepository();
    await seedSessionContracts(missing);
    assert.equal(
      runSessionController(
        missing,
        "init",
        { session: name, expectedRevision: 0 },
        {
          isolationCapacity: 1,
          mode: "full",
          platformCapacity: 1,
          workUnits: [workUnit],
          workflow: "feature",
        },
      ).status,
      0,
    );
    const trace = {
      baseRevision: "31bfee4",
      criteria: ["C01"],
      permission: "writer",
      phaseId: "feature-implement",
      role: "implementador",
      threadId: "thread-1",
      workUnitId: workUnit.workUnitId,
    };
    delete trace[omitted];
    assert.deepEqual(
      controllerOutcome(
        runSessionController(
          missing,
          "open",
          { session: name, attempt, expectedRevision: 1 },
          trace,
        ),
      ),
      { code: 2, error },
    );
  }

  const legacy = await createManagedAttempt(
    "compatibilidad-v1",
    "feature-implement--implementador--a01",
  );
  await writeFile(
    legacy.globalPath,
    (await readFile(legacy.globalPath, "utf8")).replace(
      "\n<!-- agentic-session:v1:start -->",
      "\n### Implementador heredado — intento 1\n\n- **Reporte completo:** consolidación verbosa preservada.\n\n<!-- agentic-session:v1:start -->",
    ),
    "utf8",
  );
  const before = await readFile(legacy.globalPath, "utf8");
  const status = runSessionController(legacy.repository, "status", {
    session: "compatibilidad-v1",
  });
  const recovered = runSessionController(legacy.repository, "recover", {
    session: "compatibilidad-v1",
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(await readFile(legacy.globalPath, "utf8"), before);
  assert.equal(parseManagedState(before).workUnits, undefined);
});

test("session controller exige upgrade antes de abrir un plan pre-trazabilidad", async () => {
  const fixture = await createPreTraceWorkUnitSession("plan-pre-trazabilidad-abierto");
  const attempt = "feature-test--tester--a01";
  const before = await readFile(fixture.globalPath, "utf8");

  const opened = runSessionController(
    fixture.repository,
    "open",
    { session: fixture.session, attempt, expectedRevision: 30 },
    {
      baseRevision: "revision-base",
      criteria: ["C01"],
      permission: "read-only",
      phaseId: "feature-test",
      role: "tester",
      threadId: "tester-upgrade",
      workUnitId: "unidad-legacy",
    },
  );

  assert.deepEqual(controllerOutcome(opened), {
    code: 1,
    error: "work_unit_plan_upgrade_required",
  });
  assert.equal(await readFile(fixture.globalPath, "utf8"), before);
  assert.equal(
    existsSync(join(fixture.repository, ".agents", "sessions", fixture.session, `${attempt}.md`)),
    false,
  );
});

test("session controller enriquece el plan pre-trazabilidad sin reescribir estado heredado", async () => {
  const fixture = await createPreTraceWorkUnitSession("upgrade-plan-pre-trazabilidad");
  const before = parseManagedState(await readFile(fixture.globalPath, "utf8"));

  const upgraded = runSessionController(
    fixture.repository,
    "init",
    { session: fixture.session, expectedRevision: 30 },
    fixture.approvedPlan,
  );

  assert.deepEqual(controllerResponse(upgraded), {
    command: "init",
    configured: true,
    legacy: false,
    revision: 31,
    session: fixture.session,
    state: "active",
  });
  const upgradedSource = await readFile(fixture.globalPath, "utf8");
  const expected = structuredClone(before);
  expected.evaluationGeneration = 1;
  expected.evaluationRisk = "legacy-full-mode";
  expected.evaluationStrategy = "dual";
  expected.readOnlyCapacity = 5;
  expected.revision = 31;
  expected.writerIsolationCapacity = 1;
  const expectedUnit = { acceptanceCriteria: ["C01"] };
  for (const [field, value] of Object.entries(expected.workUnits["unidad-legacy"])) {
    expectedUnit[field] = value;
  }
  expected.workUnits["unidad-legacy"] = expectedUnit;
  assert.deepEqual(parseManagedState(upgradedSource), expected);
  assert.deepEqual(expected.workUnits["unidad-legacy"].ownedPaths, ["SRC/Legacy.mjs. "]);

  const repeated = runSessionController(
    fixture.repository,
    "init",
    { session: fixture.session, expectedRevision: 31 },
    fixture.approvedPlan,
  );
  assert.deepEqual(controllerResponse(repeated), {
    command: "init",
    legacy: false,
    revision: 31,
    session: fixture.session,
    state: "active",
  });
  assert.equal(await readFile(fixture.globalPath, "utf8"), upgradedSource);
});

test("session controller mantiene divergent_work_units para un campo heredado contradictorio", async () => {
  const fixture = await createPreTraceWorkUnitSession("upgrade-plan-divergente");
  const upgraded = runSessionController(
    fixture.repository,
    "init",
    { session: fixture.session, expectedRevision: 30 },
    fixture.approvedPlan,
  );
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const before = await readFile(fixture.globalPath, "utf8");
  const contradictoryPlan = structuredClone(fixture.approvedPlan);
  contradictoryPlan.workUnits[0].permission = "read-only";

  const contradictory = runSessionController(
    fixture.repository,
    "init",
    { session: fixture.session, expectedRevision: 31 },
    contradictoryPlan,
  );

  assert.deepEqual(controllerOutcome(contradictory), {
    code: 1,
    error: "divergent_work_units",
  });
  assert.equal(await readFile(fixture.globalPath, "utf8"), before);
});

test("session controller no completa un campo ausente si otro campo presente contradice el plan", async () => {
  const fixture = await createPreTraceWorkUnitSession("upgrade-plan-divergente-atomico");
  const source = await readFile(fixture.globalPath, "utf8");
  const managed = parseManagedState(source);
  managed.workUnits["unidad-legacy"].permission = "read-only";
  await writeFile(fixture.globalPath, replaceManagedState(source, managed), "utf8");
  const before = await readFile(fixture.globalPath, "utf8");

  const contradictory = runSessionController(
    fixture.repository,
    "init",
    { session: fixture.session, expectedRevision: 30 },
    fixture.approvedPlan,
  );

  assert.deepEqual(controllerOutcome(contradictory), {
    code: 1,
    error: "divergent_work_units",
  });
  assert.equal(await readFile(fixture.globalPath, "utf8"), before);
});

test("session controller abre un Tester trazable despues del upgrade", async () => {
  const fixture = await createPreTraceWorkUnitSession("upgrade-plan-tester");
  const upgraded = runSessionController(
    fixture.repository,
    "init",
    { session: fixture.session, expectedRevision: 30 },
    fixture.approvedPlan,
  );
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const attempt = "feature-test--tester--a01";

  const opened = runSessionController(
    fixture.repository,
    "open",
    { session: fixture.session, attempt, expectedRevision: 31 },
    {
      baseRevision: "revision-base",
      criteria: ["C01"],
      permission: "read-only",
      phaseId: "feature-test",
      role: "tester",
      threadId: "tester-upgrade",
      workUnitId: "unidad-legacy",
    },
  );

  assert.deepEqual(controllerResponse(opened), {
    attempt,
    command: "open",
    revision: 32,
    session: fixture.session,
    state: "active",
  });
  const managed = parseManagedState(await readFile(fixture.globalPath, "utf8"));
  assert.deepEqual(
    {
      baseRevision: managed.attempts[attempt].baseRevision,
      criteria: managed.attempts[attempt].criteria,
      permission: managed.attempts[attempt].permission,
      threadId: managed.attempts[attempt].threadId,
    },
    {
      baseRevision: "revision-base",
      criteria: ["C01"],
      permission: "read-only",
      threadId: "tester-upgrade",
    },
  );
  assert.equal(managed.workUnits["unidad-legacy"].state, "validating");
});

test("session controller rechaza DAG y ownership ambiguos antes de crear la sesión", async () => {
  const fixtures = [
    {
      error: "invalid_work_units",
      name: "demasiadas-unidades",
      workUnits: Array.from({ length: 4 }, (_, index) => ({
        acceptanceCriteria: ["C01"],
        dependsOn: [],
        ownedPaths: [`src/${index}`],
        permission: "writer",
        workUnitId: `unidad-${index}`,
      })),
    },
    {
      error: "invalid_work_unit_contract",
      name: "contrato-incompleto",
      workUnits: [{ dependsOn: [], ownedPaths: ["src/a"], workUnitId: "unidad-a" }],
    },
    {
      error: "invalid_work_unit_id",
      name: "unidad-duplicada",
      workUnits: [
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src/a"], permission: "writer", workUnitId: "unidad-a" },
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src/b"], permission: "writer", workUnitId: "unidad-a" },
      ],
    },
    {
      error: "invalid_dependencies",
      name: "dependencia-ausente",
      workUnits: [
        {
          acceptanceCriteria: ["C01"],
          dependsOn: ["unidad-inexistente"],
          ownedPaths: ["src/a"],
          permission: "writer",
          workUnitId: "unidad-a",
        },
      ],
    },
    {
      error: "dependency_cycle",
      name: "ciclo",
      workUnits: [
        { acceptanceCriteria: ["C01"], dependsOn: ["unidad-b"], ownedPaths: ["src/a"], permission: "writer", workUnitId: "unidad-a" },
        { acceptanceCriteria: ["C01"], dependsOn: ["unidad-a"], ownedPaths: ["src/b"], permission: "writer", workUnitId: "unidad-b" },
      ],
    },
    {
      error: "invalid_owned_path",
      name: "escape",
      workUnits: [
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["../fuera"], permission: "writer", workUnitId: "unidad-a" },
      ],
    },
    {
      error: "ownership_collision",
      name: "colision-exacta",
      workUnits: [
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src/a"], permission: "writer", workUnitId: "unidad-a" },
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src/a"], permission: "writer", workUnitId: "unidad-b" },
      ],
    },
    {
      error: "ownership_collision",
      name: "colision-ancestral",
      workUnits: [
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src"], permission: "writer", workUnitId: "unidad-a" },
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src/a.mjs"], permission: "writer", workUnitId: "unidad-b" },
      ],
    },
    {
      error: "ownership_collision",
      name: "colision-windows-mayusculas",
      workUnits: [
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src/Foo.mjs"], permission: "writer", workUnitId: "unidad-a" },
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["SRC/foo.mjs"], permission: "writer", workUnitId: "unidad-b" },
      ],
    },
    {
      error: "ownership_collision",
      name: "colision-windows-terminal",
      workUnits: [
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src/foo.mjs"], permission: "writer", workUnitId: "unidad-a" },
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src/foo.mjs. "], permission: "writer", workUnitId: "unidad-b" },
      ],
    },
    {
      error: "ownership_collision",
      name: "colision-windows-ancestro",
      workUnits: [
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["SRC. "], permission: "writer", workUnitId: "unidad-a" },
        { acceptanceCriteria: ["C01"], dependsOn: [], ownedPaths: ["src/foo.mjs"], permission: "writer", workUnitId: "unidad-b" },
      ],
    },
  ];

  for (const fixture of fixtures) {
    const repository = await createRepository();
    await seedSessionContracts(repository);
    const result = runSessionController(
      repository,
      "init",
      { session: fixture.name, expectedRevision: 0 },
      {
        isolationCapacity: 9,
        mode: "full",
        platformCapacity: 12,
        workUnits: fixture.workUnits,
        workflow: "feature",
      },
    );
    assert.deepEqual(controllerOutcome(result), { code: 2, error: fixture.error });
    assert.equal(
      existsSync(join(repository, ".agents", "sessions", `${fixture.name}.md`)),
      false,
    );
  }
});

test("session controller exige validación, serializa escritores y abre fan-in", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "gates-de-unidad";
  const firstImplementation = "feature-implement--implementador--a01";
  const secondImplementation = "feature-implement--implementador--a02";
  const firstTest = "feature-test--tester--a01";
  const secondTest = "feature-test--tester--a02";
  const implementerReport = [
    "- **Archivos modificados:** cambio mínimo.",
    "- **Tareas completadas y pendientes:** completada.",
    "- **Tests creados:** permanentes.",
    "- **Validación ejecutada:** focalizada verde.",
    "- **Desvíos o dudas:** No aplica.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const testerReport = [
    "- **Evidencia:** validación completa verde.",
    "- **Tests creados:** permanentes.",
    "- **Fallos:** Ninguno.",
    "- **Omisiones:** Ninguna.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const payload = (workUnitId, phaseId, role) => ({
    baseRevision: "base",
    criteria: ["C01"],
    permission: role === "implementador" ? "writer" : "read-only",
    phaseId,
    role,
    threadId: `${role}-${workUnitId}`,
    workUnitId,
  });

  const initialized = runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    {
      isolationCapacity: 9,
      mode: "full",
      platformCapacity: 12,
      workUnits: [
        {
          acceptanceCriteria: ["C01"],
          dependsOn: [],
          ownedPaths: ["src/primera.mjs"],
          permission: "writer",
          workUnitId: "unidad-primera",
        },
        {
          acceptanceCriteria: ["C01"],
          dependsOn: ["unidad-primera"],
          ownedPaths: ["src/segunda.mjs"],
          permission: "writer",
          workUnitId: "unidad-segunda",
        },
      ],
      workflow: "feature",
    },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const dependentBefore = runSessionController(
    repository,
    "open",
    { session, attempt: firstImplementation, expectedRevision: 1 },
    payload("unidad-segunda", "feature-implement", "implementador"),
  );
  assert.deepEqual(controllerOutcome(dependentBefore), {
    code: 1,
    error: "dependencies_not_validated",
  });

  const firstOpened = runSessionController(
    repository,
    "open",
    { session, attempt: firstImplementation, expectedRevision: 1 },
    payload("unidad-primera", "feature-implement", "implementador"),
  );
  assert.equal(firstOpened.status, 0, firstOpened.stderr);
  const concurrentWriter = runSessionController(
    repository,
    "open",
    { session, attempt: secondImplementation, expectedRevision: 2 },
    payload("unidad-segunda", "feature-implement", "implementador"),
  );
  assert.deepEqual(controllerOutcome(concurrentWriter), { code: 1, error: "writer_conflict" });
  const firstCommitted = runSessionController(
    repository,
    "commit",
    { session, attempt: firstImplementation, expectedRevision: 2 },
    { report: implementerReport },
  );
  assert.equal(firstCommitted.status, 0, firstCommitted.stderr);
  const dependentBeforeValidation = runSessionController(
    repository,
    "open",
    { session, attempt: secondImplementation, expectedRevision: 3 },
    payload("unidad-segunda", "feature-implement", "implementador"),
  );
  assert.deepEqual(controllerOutcome(dependentBeforeValidation), {
    code: 1,
    error: "dependencies_not_validated",
  });

  const firstTestOpened = runSessionController(
    repository,
    "open",
    { session, attempt: firstTest, expectedRevision: 3 },
    payload("unidad-primera", "feature-test", "tester"),
  );
  assert.equal(firstTestOpened.status, 0, firstTestOpened.stderr);
  const firstValidated = runSessionController(
    repository,
    "commit",
    { session, attempt: firstTest, expectedRevision: 4 },
    { report: testerReport },
  );
  assert.equal(firstValidated.status, 0, firstValidated.stderr);
  const repeatedValidated = runSessionController(
    repository,
    "open",
    {
      session,
      attempt: secondImplementation,
      expectedRevision: 5,
    },
    payload("unidad-primera", "feature-implement", "implementador"),
  );
  assert.deepEqual(controllerOutcome(repeatedValidated), {
    code: 1,
    error: "work_unit_already_validated",
  });
  const secondOpened = runSessionController(
    repository,
    "open",
    { session, attempt: secondImplementation, expectedRevision: 5 },
    payload("unidad-segunda", "feature-implement", "implementador"),
  );
  assert.equal(secondOpened.status, 0, secondOpened.stderr);
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: secondImplementation, expectedRevision: 6 },
      { report: implementerReport },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: secondTest, expectedRevision: 7 },
      payload("unidad-segunda", "feature-test", "tester"),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: secondTest, expectedRevision: 8 },
      { report: testerReport },
    ).status,
    0,
  );

  const status = controllerResponse(runSessionController(repository, "status", { session }));
  assert.equal(status.fanInReady, true);
  assert.deepEqual(
    status.workUnits.map(({ state, validated, workUnitId }) => ({ state, validated, workUnitId })),
    [
      { state: "consolidated", validated: true, workUnitId: "unidad-primera" },
      { state: "consolidated", validated: true, workUnitId: "unidad-segunda" },
    ],
  );
});

test("session controller convierte un Tester rojo o fallido en retrabajo sin validar", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "tester-rojo";
  const implementationReport = [
    "- **Archivos modificados:** cambio.",
    "- **Tareas completadas y pendientes:** completada.",
    "- **Tests creados:** permanentes.",
    "- **Validación ejecutada:** focalizada verde.",
    "- **Desvíos o dudas:** No aplica.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const redReport = [
    "- **Evidencia:** test focalizado rojo.",
    "- **Tests creados:** permanentes.",
    "- **Fallos:** regresión reproducible.",
    "- **Omisiones:** Ninguna.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const unitPayload = (phaseId, role, extra = {}) => ({
    baseRevision: "base",
    criteria: ["C01"],
    permission: role === "implementador" ? "writer" : "read-only",
    phaseId,
    role,
    threadId: `${role}-unidad`,
    workUnitId: "unidad",
    ...extra,
  });

  assert.equal(
    runSessionController(
      repository,
      "init",
      { session, expectedRevision: 0 },
      {
        isolationCapacity: 1,
        mode: "full",
        platformCapacity: 9,
        workUnits: [
          {
            acceptanceCriteria: ["C01"],
            dependsOn: [],
            ownedPaths: ["src/unidad.mjs"],
            permission: "writer",
            workUnitId: "unidad",
          },
        ],
        workflow: "feature",
      },
    ).status,
    0,
  );
  const implementation = "feature-implement--implementador--a01";
  const testing = "feature-test--tester--a01";
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: implementation, expectedRevision: 1 },
      unitPayload("feature-implement", "implementador"),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: implementation, expectedRevision: 2 },
      { report: implementationReport },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: testing, expectedRevision: 3 },
      unitPayload("feature-test", "tester"),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: testing, expectedRevision: 4 },
      { report: redReport },
    ).status,
    0,
  );
  let status = controllerResponse(runSessionController(repository, "status", { session }));
  assert.equal(status.fanInReady, false);
  assert.deepEqual(
    status.workUnits.map(({ state, validated, workUnitId }) => ({ state, validated, workUnitId })),
    [{ state: "failed", validated: false, workUnitId: "unidad" }],
  );
  let managed = parseManagedState(
    await readFile(join(repository, ".agents", "sessions", `${session}.md`), "utf8"),
  );
  assert.equal(managed.currentPhase, "feature-test");
  assert.equal(managed.attempts[testing].evidence.outcome, "failed");
  assert.match(managed.attempts[testing].evidence.reportHash, /^[a-f0-9]{64}$/);
  assert.equal(managed.workUnits.unidad.failureCause, "regresión reproducible.");

  const rework = "feature-implement--implementador--a02";
  const reopened = runSessionController(
    repository,
    "open",
    { session, attempt: rework, expectedRevision: 5 },
    unitPayload("feature-implement", "implementador", {
      cause: "El Tester encontró una regresión.",
      previousAttempt: implementation,
    }),
  );
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: rework, expectedRevision: 6 },
      { report: implementationReport },
    ).status,
    0,
  );
  const testingRetry = "feature-test--tester--a02";
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: testingRetry, expectedRevision: 7 },
      unitPayload("feature-test", "tester", {
        cause: "Se verificó el retrabajo.",
        previousAttempt: testing,
      }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "fail",
      { session, attempt: testingRetry, expectedRevision: 8 },
      { cause: "La suite completa sigue roja." },
    ).status,
    0,
  );
  status = controllerResponse(runSessionController(repository, "status", { session }));
  assert.equal(status.fanInReady, false);
  assert.equal(status.workUnits[0].state, "failed");
  assert.equal(status.workUnits[0].validated, false);
  managed = parseManagedState(
    await readFile(join(repository, ".agents", "sessions", `${session}.md`), "utf8"),
  );
  assert.equal(managed.workUnits.unidad.failureCause, "La suite completa sigue roja.");
});

test("session controller comparte el writer lock entre DevSessions del mismo working tree", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const attempt = "feature-implement--implementador--a01";
  const report = [
    "- **Archivos modificados:** cambio.",
    "- **Tareas completadas y pendientes:** completada.",
    "- **Tests creados:** permanentes.",
    "- **Validación ejecutada:** verde.",
    "- **Desvíos o dudas:** No aplica.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  for (const session of ["writer-uno", "writer-dos"]) {
    const initialized = runSessionController(
      repository,
      "init",
      { session, expectedRevision: 0 },
      {
        isolationCapacity: 1,
        mode: "full",
        platformCapacity: 9,
        workUnits: [
          {
            acceptanceCriteria: ["C01"],
            dependsOn: [],
            ownedPaths: ["src/shared.mjs"],
            permission: "writer",
            workUnitId: "unidad",
          },
        ],
        workflow: "feature",
      },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
  }
  const payload = {
    baseRevision: "base",
    criteria: ["C01"],
    phaseId: "feature-implement",
    permission: "writer",
    role: "implementador",
    threadId: "implementador-writer",
    workUnitId: "unidad",
  };
  const missingPermission = runSessionController(
    repository,
    "open",
    { session: "writer-uno", attempt, expectedRevision: 1 },
    {
      baseRevision: "base",
      criteria: ["C01"],
      phaseId: "feature-implement",
      role: "implementador",
      threadId: "implementador-sin-permiso",
      workUnitId: "unidad",
    },
  );
  assert.deepEqual(controllerOutcome(missingPermission), {
    code: 2,
    error: "invalid_attempt_permission",
  });
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session: "writer-uno", attempt, expectedRevision: 1 },
      payload,
    ).status,
    0,
  );
  const conflicting = runSessionController(
    repository,
    "open",
    { session: "writer-dos", attempt, expectedRevision: 1 },
    payload,
  );
  assert.deepEqual(controllerOutcome(conflicting), { code: 1, error: "writer_conflict" });
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session: "writer-uno", attempt, expectedRevision: 2 },
      { report },
    ).status,
    0,
  );
  const tester = "feature-test--tester--a01";
  const readOnlyTester = runSessionController(
    repository,
    "open",
    { session: "writer-uno", attempt: tester, expectedRevision: 3 },
    {
      baseRevision: "base",
      criteria: ["C01"],
      permission: "read-only",
      phaseId: "feature-test",
      role: "tester",
      threadId: "tester-read-only",
      workUnitId: "unidad",
    },
  );
  assert.equal(readOnlyTester.status, 0, readOnlyTester.stderr);
  const openedAfterRelease = runSessionController(
    repository,
    "open",
    { session: "writer-dos", attempt, expectedRevision: 1 },
    payload,
  );
  assert.equal(openedAfterRelease.status, 0, openedAfterRelease.stderr);
  const firstSession = parseManagedState(
    await readFile(join(repository, ".agents", "sessions", "writer-uno.md"), "utf8"),
  );
  assert.equal(firstSession.attempts[tester].permission, "read-only");
});

async function createWriterSuccessionFixture(suffix) {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = `sucesion-${suffix}`;
  const contenderSession = `tercero-${suffix}`;
  const firstAttempt = "feature-implement--implementador--a01";
  const successorAttempt = "feature-implement--implementador--a02";
  const report = [
    "- **Archivos modificados:** cambio.",
    "- **Tareas completadas y pendientes:** completada.",
    "- **Tests creados:** permanentes.",
    "- **Validación ejecutada:** verde.",
    "- **Desvíos o dudas:** No aplica.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const unit = (workUnitId) => ({
    acceptanceCriteria: ["C02", "C13"],
    dependsOn: [],
    ownedPaths: [`src/${workUnitId}.mjs`],
    permission: "writer",
    workUnitId,
  });
  const units = [unit("unidad-primera"), unit("unidad-sucesora")];
  for (const [sessionSlug, workUnits] of [
    [session, units],
    [contenderSession, [unit("unidad-tercera")]],
  ]) {
    const initialized = runSessionController(
      repository,
      "init",
      { session: sessionSlug, expectedRevision: 0 },
      {
        mode: "full",
        platformCapacity: 9,
        readOnlyCapacity: 9,
        workUnits,
        workflow: "feature",
        writerIsolationCapacity: 1,
      },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
  }
  const payload = (workUnitId) => ({
    baseRevision: "base",
    criteria: ["C02", "C13"],
    permission: "writer",
    phaseId: "feature-implement",
    role: "implementador",
    threadId: `writer-${workUnitId}`,
    workUnitId,
  });
  return {
    contenderSession,
    firstAttempt,
    payload,
    report,
    repository,
    session,
    successorAttempt,
  };
}

test("session controller conserva la reserva del writer sucesor tras repetir commit terminal", async () => {
  const fixture = await createWriterSuccessionFixture("commit");
  assert.equal(
    runSessionController(
      fixture.repository,
      "open",
      { session: fixture.session, attempt: fixture.firstAttempt, expectedRevision: 1 },
      fixture.payload("unidad-primera"),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      fixture.repository,
      "commit",
      { session: fixture.session, attempt: fixture.firstAttempt, expectedRevision: 2 },
      { report: fixture.report },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      fixture.repository,
      "open",
      { session: fixture.session, attempt: fixture.successorAttempt, expectedRevision: 3 },
      fixture.payload("unidad-sucesora"),
    ).status,
    0,
  );

  const repeated = runSessionController(
    fixture.repository,
    "commit",
    { session: fixture.session, attempt: fixture.firstAttempt, expectedRevision: 4 },
    { report: fixture.report },
  );
  const contenderAttempt = "feature-implement--implementador--a01";
  const blocked = runSessionController(
    fixture.repository,
    "open",
    { session: fixture.contenderSession, attempt: contenderAttempt, expectedRevision: 1 },
    fixture.payload("unidad-tercera"),
  );
  const successorCommitted = runSessionController(
    fixture.repository,
    "commit",
    { session: fixture.session, attempt: fixture.successorAttempt, expectedRevision: 4 },
    { report: fixture.report },
  );
  const openedAfterSuccessor = runSessionController(
    fixture.repository,
    "open",
    { session: fixture.contenderSession, attempt: contenderAttempt, expectedRevision: 1 },
    fixture.payload("unidad-tercera"),
  );

  assert.deepEqual(
    {
      blocked: controllerOutcome(blocked),
      openedAfterSuccessor: openedAfterSuccessor.status,
      repeated: repeated.stdout
        ? {
            idempotent: JSON.parse(repeated.stdout).idempotent,
            revision: JSON.parse(repeated.stdout).revision,
            status: repeated.status,
          }
        : { failure: repeated.stderr },
      successorCommitted: successorCommitted.status,
    },
    {
      blocked: { code: 1, error: "writer_conflict" },
      openedAfterSuccessor: 0,
      repeated: { idempotent: true, revision: 4, status: 0 },
      successorCommitted: 0,
    },
  );
});

test("session controller conserva la reserva del writer sucesor tras repetir fail terminal", async () => {
  const fixture = await createWriterSuccessionFixture("fail");
  const firstCause = "El primer writer terminó con un fallo reproducible.";
  assert.equal(
    runSessionController(
      fixture.repository,
      "open",
      { session: fixture.session, attempt: fixture.firstAttempt, expectedRevision: 1 },
      fixture.payload("unidad-primera"),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      fixture.repository,
      "fail",
      { session: fixture.session, attempt: fixture.firstAttempt, expectedRevision: 2 },
      { cause: firstCause },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      fixture.repository,
      "open",
      { session: fixture.session, attempt: fixture.successorAttempt, expectedRevision: 3 },
      fixture.payload("unidad-sucesora"),
    ).status,
    0,
  );

  const repeated = runSessionController(
    fixture.repository,
    "fail",
    { session: fixture.session, attempt: fixture.firstAttempt, expectedRevision: 4 },
    { cause: firstCause },
  );
  const contenderAttempt = "feature-implement--implementador--a01";
  const blocked = runSessionController(
    fixture.repository,
    "open",
    { session: fixture.contenderSession, attempt: contenderAttempt, expectedRevision: 1 },
    fixture.payload("unidad-tercera"),
  );
  const successorFailed = runSessionController(
    fixture.repository,
    "fail",
    { session: fixture.session, attempt: fixture.successorAttempt, expectedRevision: 4 },
    { cause: "El writer sucesor terminó de forma controlada." },
  );
  const openedAfterSuccessor = runSessionController(
    fixture.repository,
    "open",
    { session: fixture.contenderSession, attempt: contenderAttempt, expectedRevision: 1 },
    fixture.payload("unidad-tercera"),
  );

  assert.deepEqual(
    {
      blocked: controllerOutcome(blocked),
      openedAfterSuccessor: openedAfterSuccessor.status,
      repeated: repeated.stdout
        ? { response: JSON.parse(repeated.stdout), status: repeated.status }
        : { failure: repeated.stderr },
      successorFailed: successorFailed.status,
    },
    {
      blocked: { code: 1, error: "writer_conflict" },
      openedAfterSuccessor: 0,
      repeated: {
        response: {
          attempt: fixture.firstAttempt,
          command: "fail",
          revision: 4,
          session: fixture.session,
          state: "failed",
        },
        status: 0,
      },
      successorFailed: 0,
    },
  );
});

test("session controller libera la reserva original al recuperar un commit interrumpido", async () => {
  const fixture = await createWriterSuccessionFixture("recuperacion");
  assert.equal(
    runSessionController(
      fixture.repository,
      "open",
      { session: fixture.session, attempt: fixture.firstAttempt, expectedRevision: 1 },
      fixture.payload("unidad-primera"),
    ).status,
    0,
  );
  const sessionsPath = join(fixture.repository, ".agents", "sessions");
  const writerLockName = (await readdir(sessionsPath)).find((name) =>
    /^\.writer-[a-f0-9]+\.lock$/.test(name),
  );
  assert.ok(writerLockName, "El intento writer debe mantener una reserva global.");
  const writerLockPath = join(sessionsPath, writerLockName);
  const writerLockSource = await readFile(writerLockPath, "utf8");
  const envelopePath = join(
    sessionsPath,
    fixture.session,
    `${fixture.firstAttempt}.md`,
  );
  const envelopeBeforeCommit = await readFile(envelopePath, "utf8");
  assert.equal(
    runSessionController(
      fixture.repository,
      "commit",
      { session: fixture.session, attempt: fixture.firstAttempt, expectedRevision: 2 },
      { report: fixture.report },
    ).status,
    0,
  );
  await writeFile(envelopePath, envelopeBeforeCommit, "utf8");
  await writeFile(writerLockPath, writerLockSource, { encoding: "utf8", flag: "wx" });

  const recovered = runSessionController(fixture.repository, "recover", {
    session: fixture.session,
  });
  const repeated = runSessionController(
    fixture.repository,
    "commit",
    { session: fixture.session, attempt: fixture.firstAttempt, expectedRevision: 3 },
    { report: fixture.report },
  );
  const contenderAttempt = "feature-implement--implementador--a01";
  const openedAfterRecovery = runSessionController(
    fixture.repository,
    "open",
    { session: fixture.contenderSession, attempt: contenderAttempt, expectedRevision: 1 },
    fixture.payload("unidad-tercera"),
  );

  assert.deepEqual(
    {
      openedAfterRecovery: openedAfterRecovery.status,
      recovered: controllerResponse(recovered).attempts,
      repeated: repeated.stdout
        ? {
            idempotent: JSON.parse(repeated.stdout).idempotent,
            revision: JSON.parse(repeated.stdout).revision,
            status: repeated.status,
          }
        : { failure: repeated.stderr },
    },
    {
      openedAfterRecovery: 0,
      recovered: [
        {
          attempt: fixture.firstAttempt,
          classification: "recoverable",
          state: "completed",
        },
      ],
      repeated: { idempotent: true, revision: 3, status: 0 },
    },
  );
});

test("session controller limita el fan-out por modo, plataforma, ready y aislamiento", async () => {
  async function createCapacityFixture(mode, platformCapacity, isolationCapacity) {
    const repository = await createRepository();
    await seedSessionContracts(repository);
    const workUnits = Array.from({ length: 3 }, (_, index) => ({
      acceptanceCriteria: ["C01"],
      dependsOn: [],
      ownedPaths: [],
      permission: "read-only",
      workUnitId: `unidad-${index + 1}`,
    }));
    const session = `capacidad-${mode}-${platformCapacity}-${isolationCapacity}`;
    const initialized = runSessionController(
      repository,
      "init",
      { session, expectedRevision: 0 },
      { isolationCapacity, mode, platformCapacity, workUnits, workflow: "feature" },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    return { repository, session };
  }

  const full = await createCapacityFixture("full", 3, 4);
  const light = await createCapacityFixture("light", 12, 12);
  assert.equal(
    controllerResponse(runSessionController(full.repository, "status", { session: full.session }))
      .effectiveCapacity,
    3,
  );
  assert.equal(
    controllerResponse(runSessionController(light.repository, "status", { session: light.session }))
      .agentCapacity,
    4,
  );
  assert.deepEqual(
    controllerResponse(runSessionController(full.repository, "status", { session: full.session }))
      .finalEvaluation.requiredAxes,
    ["combined"],
  );
  assert.deepEqual(
    controllerResponse(runSessionController(light.repository, "status", { session: light.session }))
      .finalEvaluation.requiredAxes,
    ["combined"],
  );
  assert.equal(
    controllerResponse(runSessionController(light.repository, "status", { session: light.session }))
      .effectiveCapacity,
    3,
  );

  function openLane(fixture, index, expectedRevision) {
    return runSessionController(
      fixture.repository,
      "open",
      {
        session: fixture.session,
        attempt: `feature-explore--explorador--a${String(index).padStart(2, "0")}`,
        expectedRevision,
      },
      {
        baseRevision: "base",
        criteria: ["C01"],
        laneId: `carril-${index}`,
        permission: "read-only",
        phaseId: "feature-explore",
        role: "explorador",
        threadId: `explorador-${index}`,
      },
    );
  }
  assert.equal(openLane(full, 1, 1).status, 0);
  assert.equal(openLane(full, 2, 2).status, 0);
  assert.equal(openLane(full, 3, 3).status, 0);
  assert.deepEqual(controllerOutcome(openLane(full, 4, 4)), {
    code: 1,
    error: "role_capacity_reached",
  });
  assert.equal(openLane(light, 1, 1).status, 0);
  assert.equal(openLane(light, 2, 2).status, 0);
  assert.deepEqual(controllerOutcome(openLane(light, 3, 3)), {
    code: 1,
    error: "role_capacity_reached",
  });
  const constrained = await createCapacityFixture("full", 1, 9);
  assert.equal(openLane(constrained, 1, 1).status, 0);
  assert.deepEqual(controllerOutcome(openLane(constrained, 2, 2)), {
    code: 1,
    error: "agent_capacity_reached",
  });
  const singleWriterIsolation = await createCapacityFixture("full", 9, 1);
  assert.equal(openLane(singleWriterIsolation, 1, 1).status, 0);
  assert.equal(openLane(singleWriterIsolation, 2, 2).status, 0);
  assert.equal(openLane(singleWriterIsolation, 3, 3).status, 0);

  const beforeDag = await createManagedSession("capacidad-desde-init");
  assert.equal(openLane({ repository: beforeDag.repository, session: "capacidad-desde-init" }, 1, 1).status, 0);
  assert.equal(openLane({ repository: beforeDag.repository, session: "capacidad-desde-init" }, 2, 2).status, 0);
  assert.equal(openLane({ repository: beforeDag.repository, session: "capacidad-desde-init" }, 3, 3).status, 0);
  assert.deepEqual(
    controllerOutcome(
      openLane({ repository: beforeDag.repository, session: "capacidad-desde-init" }, 4, 4),
    ),
    { code: 1, error: "role_capacity_reached" },
  );

  const plannedLater = await createManagedSession("plan-configurado-despues");
  const configured = runSessionController(
    plannedLater.repository,
    "init",
    { session: "plan-configurado-despues", expectedRevision: 1 },
    {
      isolationCapacity: 2,
      mode: "full",
      platformCapacity: 2,
      workUnits: [
        {
          acceptanceCriteria: ["C01"],
          dependsOn: [],
          ownedPaths: [],
          permission: "read-only",
          workUnitId: "unidad-lectura",
        },
      ],
      workflow: "feature",
    },
  );
  assert.deepEqual(controllerResponse(configured), {
    command: "init",
    configured: true,
    legacy: false,
    revision: 2,
    session: "plan-configurado-despues",
    state: "active",
  });
});

test("session controller separa los cupos read-only y writer bajo el límite técnico", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "capacidad-lectura-escritura";
  const writer = "feature-implement--implementador--a01";
  const reader = "feature-explore--explorador--a01";
  const secondReader = "feature-plan--planificador--a01";
  const secondWriter = "feature-implement--implementador--a02";
  const implementationReport = [
    "- **Archivos modificados:** cambio.",
    "- **Tareas completadas y pendientes:** completada.",
    "- **Tests creados:** permanentes.",
    "- **Validación ejecutada:** verde.",
    "- **Desvíos o dudas:** No aplica.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const lanePayload = (phaseId, role, laneId) => ({
    baseRevision: "base",
    criteria: ["C01"],
    laneId,
    permission: "read-only",
    phaseId,
    role,
    threadId: `${role}-${laneId}`,
  });

  assert.equal(
    runSessionController(
      repository,
      "init",
      { session, expectedRevision: 0 },
      {
        mode: "full",
        platformCapacity: 2,
        readOnlyCapacity: 1,
        writerIsolationCapacity: 1,
        workUnits: [
          {
            acceptanceCriteria: ["C01"],
            dependsOn: [],
            ownedPaths: ["src/unidad.mjs"],
            permission: "writer",
            workUnitId: "unidad",
          },
          {
            acceptanceCriteria: ["C01"],
            dependsOn: [],
            ownedPaths: ["src/otra-unidad.mjs"],
            permission: "writer",
            workUnitId: "otra-unidad",
          },
        ],
        workflow: "feature",
      },
    ).status,
    0,
  );
  assert.equal(
    controllerResponse(runSessionController(repository, "status", { session })).agentCapacity,
    2,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: writer, expectedRevision: 1 },
      {
        baseRevision: "base",
        criteria: ["C01"],
        permission: "writer",
        phaseId: "feature-implement",
        role: "implementador",
        threadId: "implementador-unidad",
        workUnitId: "unidad",
      },
    ).status,
    0,
  );
  assert.deepEqual(
    controllerOutcome(
      runSessionController(
        repository,
        "open",
        { session, attempt: secondWriter, expectedRevision: 2 },
        {
          baseRevision: "base",
          criteria: ["C01"],
          permission: "writer",
          phaseId: "feature-implement",
          role: "implementador",
          threadId: "implementador-otra-unidad",
          workUnitId: "otra-unidad",
        },
      ),
    ),
    { code: 1, error: "writer_conflict" },
  );
  const readerOpened = runSessionController(
    repository,
    "open",
    { session, attempt: reader, expectedRevision: 2 },
    lanePayload("feature-explore", "explorador", "carril-exploracion"),
  );
  assert.equal(readerOpened.status, 0, readerOpened.stderr);

  assert.deepEqual(
    controllerOutcome(
      runSessionController(
        repository,
        "open",
        { session, attempt: secondReader, expectedRevision: 3 },
        lanePayload("feature-plan", "planificador", "carril-plan"),
      ),
    ),
    { code: 1, error: "agent_capacity_reached" },
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: writer, expectedRevision: 3 },
      { report: implementationReport },
    ).status,
    0,
  );
  assert.deepEqual(
    controllerOutcome(
      runSessionController(
        repository,
        "open",
        { session, attempt: secondReader, expectedRevision: 4 },
        lanePayload("feature-plan", "planificador", "carril-plan"),
      ),
    ),
    { code: 1, error: "agent_capacity_reached" },
  );
});

test("session controller usa evaluación combinada por defecto y exige riesgo explícito para dual", async () => {
  const workUnits = [
    {
      acceptanceCriteria: ["C01"],
      dependsOn: [],
      ownedPaths: ["src/unidad.mjs"],
      permission: "writer",
      workUnitId: "unidad",
    },
  ];
  const invalidConfigurations = [
    {
      error: "evaluation_risk_required",
      evaluationStrategy: "dual",
      session: "dual-sin-riesgo",
    },
    {
      error: "invalid_evaluation_risk",
      evaluationRisk: "riesgo-inventado",
      evaluationStrategy: "dual",
      session: "dual-riesgo-invalido",
    },
    {
      error: "unexpected_evaluation_risk",
      evaluationRisk: "security-or-integrity",
      evaluationStrategy: "combined",
      session: "combinada-con-riesgo",
    },
  ];

  for (const fixture of invalidConfigurations) {
    const repository = await createRepository();
    await seedSessionContracts(repository);
    const result = runSessionController(
      repository,
      "init",
      { session: fixture.session, expectedRevision: 0 },
      {
        evaluationRisk: fixture.evaluationRisk,
        evaluationStrategy: fixture.evaluationStrategy,
        mode: "full",
        workUnits,
        workflow: "feature",
      },
    );
    assert.deepEqual(controllerOutcome(result), { code: 2, error: fixture.error });
  }

  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "evaluacion-combinada-predeterminada";
  const initialized = runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    { mode: "full", workUnits, workflow: "feature" },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.deepEqual(
    controllerResponse(runSessionController(repository, "status", { session })).finalEvaluation,
    {
      approved: false,
      axes: { combined: "pending" },
      generation: 1,
      requiredAxes: ["combined"],
      strategy: "combined",
    },
  );

  const tracedPayload = (phaseId, role, extra = {}) => ({
    baseRevision: "base",
    criteria: ["C01"],
    permission: role === "implementador" ? "writer" : "read-only",
    phaseId,
    role,
    threadId: `${role}-${extra.evaluationAxis ?? extra.workUnitId}`,
    ...extra,
  });
  const reports = {
    evaluador: [
      "- **Veredicto:** aprobado.",
      "- **Criterios verificados:** todos.",
      "- **Hallazgos:** Ninguno.",
      "- **Riesgo residual y evidencia faltante:** No aplica.",
      "- **Memoria guardada o candidata:** No aplica.",
    ].join("\n"),
    implementador: [
      "- **Archivos modificados:** cambio.",
      "- **Tareas completadas y pendientes:** completada.",
      "- **Tests creados:** permanentes.",
      "- **Validación ejecutada:** focalizada verde.",
      "- **Desvíos o dudas:** No aplica.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
    tester: [
      "- **Evidencia:** focalizada verde.",
      "- **Tests creados:** permanentes.",
      "- **Fallos:** Ninguno.",
      "- **Omisiones:** Ninguna.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
  };
  const implementation = "feature-implement--implementador--a01";
  const testing = "feature-test--tester--a01";
  const evaluation = "feature-evaluate--evaluador--a01";
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: implementation, expectedRevision: 1 },
      tracedPayload("feature-implement", "implementador", { workUnitId: "unidad" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: implementation, expectedRevision: 2 },
      { report: reports.implementador },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: testing, expectedRevision: 3 },
      tracedPayload("feature-test", "tester", { workUnitId: "unidad" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: testing, expectedRevision: 4 },
      { report: reports.tester },
    ).status,
    0,
  );
  assert.deepEqual(
    controllerOutcome(
      runSessionController(
        repository,
        "open",
        { session, attempt: evaluation, expectedRevision: 5 },
        tracedPayload("feature-evaluate", "evaluador", { evaluationAxis: "standards" }),
      ),
    ),
    { code: 2, error: "invalid_evaluation_axis" },
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: evaluation, expectedRevision: 5 },
      tracedPayload("feature-evaluate", "evaluador", { evaluationAxis: "combined" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: evaluation, expectedRevision: 6 },
      { report: reports.evaluador },
    ).status,
    0,
  );
  assert.deepEqual(
    controllerResponse(runSessionController(repository, "status", { session })).finalEvaluation,
    {
      approved: true,
      axes: { combined: "approved" },
      generation: 1,
      requiredAxes: ["combined"],
      strategy: "combined",
    },
  );
});

test("session controller exige fan-in y consolida la evaluación dual justificada", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "evaluacion-por-ejes";
  const implementation = "feature-implement--implementador--a01";
  const testing = "feature-test--tester--a01";
  const standards = "feature-evaluate--evaluador--a01";
  const specification = "feature-evaluate--evaluador--a02";
  const implementationReport = [
    "- **Archivos modificados:** cambio.",
    "- **Tareas completadas y pendientes:** completada.",
    "- **Tests creados:** permanentes.",
    "- **Validación ejecutada:** verde.",
    "- **Desvíos o dudas:** No aplica.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const testingReport = [
    "- **Evidencia:** verde.",
    "- **Tests creados:** permanentes.",
    "- **Fallos:** Ninguno.",
    "- **Omisiones:** Ninguna.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const evaluationReport = [
    "- **Veredicto:** aprobado.",
    "- **Criterios verificados:** todos.",
    "- **Hallazgos:** Ninguno.",
    "- **Riesgo residual y evidencia faltante:** No aplica.",
    "- **Memoria guardada o candidata:** No aplica.",
  ].join("\n");
  const changesRequiredReport = evaluationReport.replace(
    "- **Veredicto:** aprobado.",
    "- **Veredicto:** cambios requeridos.",
  );
  const tracedPayload = (phaseId, role, extra = {}) => ({
    baseRevision: "base",
    criteria: ["C01"],
    permission: role === "implementador" ? "writer" : "read-only",
    phaseId,
    role,
    threadId: `${role}-${extra.evaluationAxis ?? extra.workUnitId ?? "final"}`,
    ...extra,
  });
  runSessionController(
    repository,
    "init",
    { session, expectedRevision: 0 },
    {
      evaluationRisk: "security-or-integrity",
      evaluationStrategy: "dual",
      isolationCapacity: 1,
      mode: "full",
      platformCapacity: 12,
      workUnits: [
          {
            acceptanceCriteria: ["C01"],
            dependsOn: [],
          ownedPaths: ["src/unidad.mjs"],
          permission: "writer",
          workUnitId: "unidad",
        },
      ],
      workflow: "feature",
    },
  );
  const prematureEvaluation = runSessionController(
    repository,
    "open",
    { session, attempt: standards, expectedRevision: 1 },
    tracedPayload("feature-evaluate", "evaluador", { evaluationAxis: "standards" }),
  );
  assert.deepEqual(controllerOutcome(prematureEvaluation), { code: 1, error: "fan_in_pending" });
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: implementation, expectedRevision: 1 },
      tracedPayload("feature-implement", "implementador", { workUnitId: "unidad" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: implementation, expectedRevision: 2 },
      { report: implementationReport },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: testing, expectedRevision: 3 },
      tracedPayload("feature-test", "tester", { workUnitId: "unidad" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: testing, expectedRevision: 4 },
      { report: testingReport },
    ).status,
    0,
  );
  const fanInStatus = controllerResponse(
    runSessionController(repository, "status", { session }),
  );
  assert.equal(fanInStatus.evaluationCapacity, 2);
  assert.equal(fanInStatus.effectiveCapacity, 2);
  assert.equal(fanInStatus.writerIsolationCapacity, 1);
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: standards, expectedRevision: 5 },
      tracedPayload("feature-evaluate", "evaluador", { evaluationAxis: "standards" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: specification, expectedRevision: 6 },
      tracedPayload("feature-evaluate", "evaluador", { evaluationAxis: "specification" }),
    ).status,
    0,
  );
  const duplicatedAxis = runSessionController(
    repository,
    "open",
    {
      session,
      attempt: "feature-evaluate--evaluador--a03",
      expectedRevision: 7,
    },
    tracedPayload("feature-evaluate", "evaluador", { evaluationAxis: "standards" }),
  );
  assert.deepEqual(controllerOutcome(duplicatedAxis), {
    code: 1,
    error: "evaluation_axis_conflict",
  });
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: standards, expectedRevision: 7 },
      { report: changesRequiredReport },
    ).status,
    0,
  );
  const standardsRetry = "feature-evaluate--evaluador--a03";
  const retriedAxis = runSessionController(
    repository,
    "open",
    { session, attempt: standardsRetry, expectedRevision: 8 },
    tracedPayload("feature-evaluate", "evaluador", {
      cause: "El eje anterior pidió cambios.",
      evaluationAxis: "standards",
      previousAttempt: standards,
    }),
  );
  assert.equal(retriedAxis.status, 0, retriedAxis.stderr);
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: standardsRetry, expectedRevision: 9 },
      { report: evaluationReport },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: specification, expectedRevision: 10 },
      { report: evaluationReport },
    ).status,
    0,
  );
  assert.deepEqual(
    controllerResponse(runSessionController(repository, "status", { session })).finalEvaluation,
    {
      approved: true,
      axes: { specification: "approved", standards: "approved" },
      generation: 1,
      risk: "security-or-integrity",
      requiredAxes: ["standards", "specification"],
      strategy: "dual",
    },
  );
  const reopened = runSessionController(
    repository,
    "open",
    {
      session,
      attempt: "feature-implement--implementador--a02",
      expectedRevision: 11,
    },
    tracedPayload("feature-implement", "implementador", {
      cause: "La evaluación final detectó una regresión.",
      impact: "El hallazgo afecta la unidad ya validada.",
      previousAttempt: implementation,
      workUnitId: "unidad",
    }),
  );
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.deepEqual(
    controllerResponse(runSessionController(repository, "status", { session })).finalEvaluation,
    {
      approved: false,
      axes: { specification: "pending", standards: "pending" },
      generation: 2,
      risk: "security-or-integrity",
      requiredAxes: ["standards", "specification"],
      strategy: "dual",
    },
  );
});

test("session controller neutraliza una evaluación consolidada tras reabrir el fan-in", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "evaluacion-generacion-obsoleta";
  const implementationReport = [
    "- **Archivos modificados:** cambio.",
    "- **Tareas completadas y pendientes:** completada.",
    "- **Tests creados:** permanentes.",
    "- **Validación ejecutada:** verde.",
    "- **Desvíos o dudas:** No aplica.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const testingReport = [
    "- **Evidencia:** verde.",
    "- **Tests creados:** permanentes.",
    "- **Fallos:** Ninguno.",
    "- **Omisiones:** Ninguna.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const evaluationReport = [
    "- **Veredicto:** aprobado.",
    "- **Criterios verificados:** todos.",
    "- **Hallazgos:** Ninguno.",
    "- **Riesgo residual y evidencia faltante:** No aplica.",
    "- **Memoria guardada o candidata:** No aplica.",
  ].join("\n");
  const tracedPayload = (phaseId, role, extra = {}) => ({
    baseRevision: "base",
    criteria: ["C01"],
    permission: role === "implementador" ? "writer" : "read-only",
    phaseId,
    role,
    threadId: `${role}-${extra.evaluationAxis ?? extra.workUnitId}`,
    ...extra,
  });
  const implementation = "feature-implement--implementador--a01";
  const rework = "feature-implement--implementador--a02";
  const testing = "feature-test--tester--a01";
  const testingRetry = "feature-test--tester--a02";
  const obsoleteStandards = "feature-evaluate--evaluador--a01";
  const currentSpecification = "feature-evaluate--evaluador--a02";

  assert.equal(
    runSessionController(
      repository,
      "init",
      { session, expectedRevision: 0 },
      {
        evaluationRisk: "security-or-integrity",
        evaluationStrategy: "dual",
        isolationCapacity: 1,
        mode: "full",
        platformCapacity: 3,
        readOnlyCapacity: 2,
        workUnits: [
          {
            acceptanceCriteria: ["C01"],
            dependsOn: [],
            ownedPaths: ["src/unidad.mjs"],
            permission: "writer",
            workUnitId: "unidad",
          },
        ],
        workflow: "feature",
      },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: implementation, expectedRevision: 1 },
      tracedPayload("feature-implement", "implementador", { workUnitId: "unidad" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: implementation, expectedRevision: 2 },
      { report: implementationReport },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: testing, expectedRevision: 3 },
      tracedPayload("feature-test", "tester", { workUnitId: "unidad" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: testing, expectedRevision: 4 },
      { report: testingReport },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: obsoleteStandards, expectedRevision: 5 },
      tracedPayload("feature-evaluate", "evaluador", { evaluationAxis: "standards" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: rework, expectedRevision: 6 },
      tracedPayload("feature-implement", "implementador", {
        cause: "La evaluación detectó impacto.",
        impact: "El hallazgo exige revalidar la unidad.",
        previousAttempt: implementation,
        workUnitId: "unidad",
      }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: obsoleteStandards, expectedRevision: 7 },
      { report: evaluationReport },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: rework, expectedRevision: 8 },
      { report: implementationReport },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: testingRetry, expectedRevision: 9 },
      tracedPayload("feature-test", "tester", {
        cause: "Se revalida el retrabajo.",
        previousAttempt: testing,
        workUnitId: "unidad",
      }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: testingRetry, expectedRevision: 10 },
      { report: testingReport },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: currentSpecification, expectedRevision: 11 },
      tracedPayload("feature-evaluate", "evaluador", { evaluationAxis: "specification" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: currentSpecification, expectedRevision: 12 },
      { report: evaluationReport },
    ).status,
    0,
  );

  const managed = parseManagedState(
    await readFile(join(repository, ".agents", "sessions", `${session}.md`), "utf8"),
  );
  const finalEvaluation = controllerResponse(
    runSessionController(repository, "status", { session }),
  ).finalEvaluation;
  assert.deepEqual(
    {
      finalEvaluation,
      obsoleteOutcome: managed.attempts[obsoleteStandards].evidence.outcome,
      storedStandards: managed.evaluations.standards,
    },
    {
      finalEvaluation: {
        approved: false,
        axes: { specification: "approved", standards: "pending" },
        generation: 2,
        risk: "security-or-integrity",
        requiredAxes: ["standards", "specification"],
        strategy: "dual",
      },
      obsoleteOutcome: "obsolete",
      storedStandards: undefined,
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

test("session controller conserva el reporte íntegro solo en la SubDevSession e indexa la global", async () => {
  const attempt = "feature-implement--implementador--a01";

  async function commitReport(session, detail) {
    const repository = await createRepository();
    await seedSessionContracts(repository);
    const marker = `MARCADOR_UNICO_DEL_REPORTE_${detail}`;
    const report = [
      `- **Archivos modificados:** ${marker}`,
      "- **Tareas completadas y pendientes:** completadas.",
      "- **Tests creados:** permanentes.",
      "- **Validación ejecutada:** focalizada verde.",
      "- **Desvíos o dudas:** No aplica.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n");
    const initialized = runSessionController(
      repository,
      "init",
      { session, expectedRevision: 0 },
      {
        isolationCapacity: 1,
        mode: "full",
        platformCapacity: 1,
        workUnits: [
          {
            acceptanceCriteria: ["C01"],
            dependsOn: [],
            ownedPaths: ["src/indice.mjs"],
            permission: "writer",
            workUnitId: "unidad-indice",
          },
        ],
        workflow: "feature",
      },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    const opened = runSessionController(
      repository,
      "open",
      { session, attempt, expectedRevision: 1 },
      {
        baseRevision: "base",
        criteria: ["C01"],
        permission: "writer",
        phaseId: "feature-implement",
        role: "implementador",
        threadId: `hilo-${session}`,
        workUnitId: "unidad-indice",
      },
    );
    assert.equal(opened.status, 0, opened.stderr);

    const globalPath = join(repository, ".agents", "sessions", `${session}.md`);
    const envelopePath = join(
      repository,
      ".agents",
      "sessions",
      session,
      `${attempt}.md`,
    );
    const globalBefore = await readFile(globalPath, "utf8");
    const committed = runSessionController(
      repository,
      "commit",
      { session, attempt, expectedRevision: 2 },
      { report },
    );
    assert.equal(committed.status, 0, committed.stderr);
    const response = JSON.parse(committed.stdout);
    const repeated = runSessionController(
      repository,
      "commit",
      { session, attempt, expectedRevision: 3 },
      { report },
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    const status = runSessionController(repository, "status", { session });
    assert.equal(status.status, 0, status.stderr);

    return {
      envelope: await readFile(envelopePath, "utf8"),
      global: await readFile(globalPath, "utf8"),
      globalGrowth: (await readFile(globalPath, "utf8")).length - globalBefore.length,
      marker,
      reportHash: response.reportHash,
      repeated: JSON.parse(repeated.stdout),
      status: JSON.parse(status.stdout),
    };
  }

  const short = await commitReport("indice-corto", "breve");
  const long = await commitReport("indice-largo", "x".repeat(8_192));
  const reference =
    `- Sesión: \`indice-largo\`; intento: \`${attempt}\`; fase: \`feature-implement\`; ` +
    `rol: \`implementador\`; unidad: \`unidad-indice\`; estado: \`completed\`; ` +
    `resultado: \`completed\`; hash: \`${long.reportHash}\`; ` +
    `reporte: \`.agents/sessions/indice-largo/${attempt}.md\`.`;

  assert.equal(long.envelope.split(long.marker).length - 1, 1);
  assert.equal(
    long.global.includes(long.marker),
    false,
    "la DevSession global duplicó el cuerpo íntegro del reporte",
  );
  assert.ok(long.global.includes(reference));
  assert.equal(long.globalGrowth, short.globalGrowth);
  assert.equal(JSON.stringify(long.status).includes(long.marker), false);
  assert.deepEqual(
    {
      idempotent: long.repeated.idempotent,
      reportHash: long.repeated.reportHash,
      revision: long.repeated.revision,
      state: long.repeated.state,
    },
    { idempotent: true, reportHash: long.reportHash, revision: 3, state: "completed" },
  );
});

test("session controller informa status desde el ledger sin leer el cuerpo de la SubDevSession", async () => {
  const session = "status-sin-cuerpo";
  const attempt = "feature-implement--implementador--a01";
  const fixture = await createManagedAttempt(session, attempt);
  const failed = runSessionController(
    fixture.repository,
    "fail",
    { session, attempt, expectedRevision: 2 },
    { cause: "Fallo controlado para cerrar el intento." },
  );
  assert.equal(failed.status, 0, failed.stderr);

  const envelope = await readFile(fixture.envelopePath);
  const managedBlock = Buffer.from("<!-- agentic-session:v1:start -->", "utf8");
  const managedAt = envelope.indexOf(managedBlock);
  assert.ok(managedAt > 0, "La SubDevSession debe conservar un bloque administrado válido.");
  await writeFile(
    fixture.envelopePath,
    Buffer.concat([Buffer.from([0xff]), envelope.subarray(managedAt)]),
  );

  const status = runSessionController(fixture.repository, "status", { session });
  const recovered = runSessionController(fixture.repository, "recover", { session });
  const cleaned = runSessionController(fixture.repository, "cleanup", {
    session,
    expectedRevision: 3,
  });

  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).attempts, [
    { attempt, classification: "safe_to_delete", state: "failed" },
  ]);
  assert.deepEqual(JSON.parse(recovered.stdout).attempts, [
    { attempt, classification: "ambiguous", state: "failed" },
  ]);
  assert.deepEqual(JSON.parse(cleaned.stdout).deleted, []);
  assert.equal(existsSync(fixture.envelopePath), true);
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

test("los contratos canónicos definen cierre, validación y evaluación proporcionales", async () => {
  const agentsContract = await readFile(join(ROOT, "AGENTS.md"), "utf8");
  const orchestration = await readFile(
    join(ROOT, ".agents", "policies", "orquestacion.md"),
    "utf8",
  );
  const skill = await readFile(
    join(ROOT, ".agents", "skills", "orquestar", "SKILL.md"),
    "utf8",
  );
  const tdd = await readFile(
    join(ROOT, ".agents", "skills", "agentic-tdd", "SKILL.md"),
    "utf8",
  );
  const roles = Object.fromEntries(
    await Promise.all(
      ["documentador", "evaluador", "explorador", "implementador", "planificador", "tester"].map(
        async (role) => [
          role,
          await readFile(join(ROOT, ".agents", "roles", `${role}.md`), "utf8"),
        ],
      ),
    ),
  );
  const workflows = Object.fromEntries(
    await Promise.all(
      ["architecture", "bugfix", "feature", "refactor"].map(async (workflow) => [
        workflow,
        await readFile(join(ROOT, ".agents", "workflows", `${workflow}.md`), "utf8"),
      ]),
    ),
  );
  const devSession = await readFile(
    join(ROOT, ".agents", "templates", "dev-session.md"),
    "utf8",
  );
  const subdevSession = await readFile(
    join(ROOT, ".agents", "templates", "subdev-session.md"),
    "utf8",
  );
  const codexAdapter = await readFile(
    join(ROOT, ".codex", "agents", "implementador.toml"),
    "utf8",
  );
  const claudeAdapter = await readFile(
    join(ROOT, ".claude", "agents", "implementador.md"),
    "utf8",
  );

  assert.match(orchestration, /`light`[^\n]*4 subagentes/);
  assert.match(orchestration, /`full`[^\n]*9 subagentes/);
  assert.match(orchestration, /m[ií]nimo entre[\s\S]*modo[\s\S]*plataforma[\s\S]*listas[\s\S]*aislamiento/i);
  assert.match(orchestration, /agentes reales[\s\S]*no (?:simular|sustituirlos por procesos auxiliares)/i);
  assert.match(orchestration, /un solo escritor activo por working tree/i);
  assert.match(orchestration, /validación completa una sola vez[\s\S]*antes de la evaluación final/i);
  assert.match(orchestration, /un solo Evaluador[\s\S]*Estándares[\s\S]*Especificación[\s\S]*evaluationStrategy: dual/i);
  assert.match(orchestration, /evaluationRisk[\s\S]*architectural-decision[\s\S]*security-or-integrity/);
  assert.match(
    orchestration,
    /cuerpo íntegro[\s\S]*SubDevSession[\s\S]*referencia compacta[\s\S]*bloque administrado/i,
  );
  assert.match(orchestration, /Evaluador[\s\S]*Documentador[\s\S]*pasar sus rutas[\s\S]*antes de `cleanup`/i);
  assert.match(skill, /fan-out[\s\S]*oleadas[\s\S]*fan-in/i);
  assert.match(skill, /cerrar cada hilo/i);
  assert.match(skill, /un Evaluador[\s\S]*conjuntamente[\s\S]*dos Evaluadores independientes/i);
  assert.match(skill, /SubDevSession[\s\S]*referencia compacta[\s\S]*seleccionar explícitamente/i);
  assert.match(roles.explorador, /carril asignado/i);
  assert.match(roles.planificador, /workUnitId[\s\S]*dependsOn[\s\S]*owned_paths/);
  assert.match(roles.implementador, /una sola unidad/i);
  assert.match(roles.tester, /implementada[\s\S]*validada[\s\S]*consolidada/i);
  assert.match(roles.tester, /sin repetir la suite completa[\s\S]*después del fan-in/i);
  assert.match(roles.evaluador, /eje combinado[\s\S]*evaluación dual justificada/i);
  assert.match(roles.evaluador, /Rutas explícitas[\s\S]*nunca el\s+historial completo/i);
  assert.match(roles.documentador, /fan-in/i);
  assert.match(roles.documentador, /Rutas explícitas[\s\S]*nunca el\s+historial completo/i);
  assert.match(roles.documentador, /architecture-propose[^\n]*no exige fan-in/i);
  assert.match(roles.documentador, /architecture-record[\s\S]*cerrar una tarea exclusivamente arquitectónica/i);
  for (const source of [workflows.bugfix, workflows.feature, workflows.refactor]) {
    assert.match(source, /unidad(?:es)? de (?:implementación|trabajo)/i);
    assert.match(source, /fan-in/i);
  }
  assert.match(workflows.feature, /Un Evaluador[\s\S]*combinada[\s\S]*Dos Evaluadores independientes/i);
  assert.match(workflows.architecture, /termina[\s\S]*architecture-record[\s\S]*no exige unidades/i);
  assert.match(workflows.architecture, /transferirla[\s\S]*una sola vez[\s\S]*feature[\s\S]*refactor/i);
  assert.doesNotMatch(
    workflows.architecture,
    /agentic-phase:v1 \{"id":"architecture-(?:implement|evaluate|document)"/,
  );
  assert.match(tdd, /un comportamiento observable por test[\s\S]*todas las aserciones[\s\S]*necesarias/i);
  assert.match(tdd, /refactor acotado[\s\S]*volver a ejecutar la validación focalizada/i);
  assert.doesNotMatch(tdd, /una aserción lógica por test/i);
  assert.match(
    agentsContract,
    /node --test --test-name-pattern="<patrón concreto del caso relacionado>"[\s\S]*tests\/agentic-init\.test\.mjs/,
  );
  assert.match(devSession, /## Presupuesto y capacidad/);
  assert.match(devSession, /## Unidades de implementación/);
  assert.match(devSession, /## Evaluación final por ejes/);
  assert.match(devSession, /evaluationStrategy[\s\S]*evaluationRisk/);
  assert.match(devSession, /## Índice compacto de reportes[\s\S]*SubDevSession indicada/);
  assert.match(subdevSession, /- Unidad: `<work-unit-id>`/);
  assert.match(subdevSession, /- Permiso: `<permission>`/);
  assert.match(subdevSession, /Única fuente del cuerpo íntegro[\s\S]*referencia compacta/);
  assert.match(codexAdapter, /\.agents\/roles\/implementador\.md/);
  assert.match(claudeAdapter, /\.agents\/roles\/implementador\.md/);
  assert.doesNotMatch(codexAdapter + claudeAdapter, /light\s*=\s*4|full\s*=\s*9/);
});

test("la activación canónica decide por riesgo y mantiene consumidores delgados", async () => {
  const [agentsContract, orchestration, skill, claudeAdapter, readme] = await Promise.all([
    readFile(join(ROOT, "AGENTS.md"), "utf8"),
    readFile(join(ROOT, ".agents", "policies", "orquestacion.md"), "utf8"),
    readFile(join(ROOT, ".agents", "skills", "orquestar", "SKILL.md"), "utf8"),
    readFile(join(ROOT, ".claude", "skills", "orquestar", "SKILL.md"), "utf8"),
    readFile(join(ROOT, "README.md"), "utf8"),
  ]);
  const activationSeam = agentsContract.match(
    /## Activación y modo\n([\s\S]*?)\n## Requisitos globales/,
  )?.[1];

  assert.match(activationSeam ?? "", /fuente normativa/i);
  assert.match(activationSeam ?? "", /sin orquestar[\s\S]*seguridad/i);
  assert.doesNotMatch(
    [activationSeam, skill, claudeAdapter].join("\n"),
    /tareas? no triviales?|cambios?\s+multiarchivo|comportamiento nuevo/i,
  );

  assert.match(orchestration, /## Decisión de activación/);
  assert.doesNotMatch(
    orchestration,
    /tareas? no triviales?:|cambios?\s+multiarchivo,\s*comportamiento nuevo/i,
  );
  assert.match(orchestration, /instrucciones explícitas[\s\S]*límites de seguridad/i);
  assert.match(orchestration, /varios\s+archivos estrechamente relacionados[\s\S]*ejecución directa/i);
  assert.match(orchestration, /seguridad[\s\S]*activa `full`/i);
  assert.match(orchestration, /migración o compatibilidad pública[\s\S]*`full`/i);
  assert.match(orchestration, /bug reproducible[\s\S]*causa directa[\s\S]*ejecución directa/i);
  assert.match(orchestration, /intermitente[\s\S]*hipótesis competidoras[\s\S]*`full`/i);
  assert.match(orchestration, /falta un hecho[\s\S]*cambiaría la categoría/i);
  assert.match(orchestration, /entrega\s+directa[\s\S]*por qué era elegible[\s\S]*validación/i);
  assert.equal(
    orchestration.match(/^### Categorías de `full` automático$/gm)?.length,
    1,
  );
  assert.doesNotMatch(
    skill + claudeAdapter,
    /decisión arquitectónica durable|hipótesis competidoras|concurrencia de escritores/i,
  );

  assert.match(readme, /\| Directa verificada \|/);
  assert.match(readme, /\| `light` \|/);
  assert.match(readme, /\| `full` \|/);
  assert.match(readme, /cantidad de archivos[\s\S]*no determina[\s\S]*riesgo/i);
});

test("el diagnóstico de bugs escala con la incertidumbre y conserva sus guardrails", async () => {
  const [diagnostic, bugfix] = await Promise.all([
    readFile(
      join(ROOT, ".agents", "skills", "agentic-diagnostico-bugs", "SKILL.md"),
      "utf8",
    ),
    readFile(join(ROOT, ".agents", "workflows", "bugfix.md"), "utf8"),
  ]);
  const direct = diagnostic.match(/### Ruta directa\n([\s\S]*?)(?=\n### |\n## |$)/i)?.[1] ?? "";
  const investigative =
    diagnostic.match(/### Ruta investigativa\n([\s\S]*?)(?=\n### |\n## |$)/i)?.[1] ?? "";
  const blocked = diagnostic.match(/### Bloqueo\n([\s\S]*?)(?=\n### |\n## |$)/i)?.[1] ?? "";

  assert.match(
    direct,
    /determinista[\s\S]*(?:una|única) hipótesis[\s\S]*(?:predicción|evidencia)/i,
  );
  assert.match(investigative, /causas? (?:plausibles )?(?:compiten|competidoras)[\s\S]*falsable/i);
  assert.match(diagnostic, /intermitente[\s\S]*tasa de reproducción[\s\S]*med/i);
  assert.match(direct, /sin (?:un )?checkpoint|no (?:requiere|hay) (?:un )?checkpoint/i);
  assert.match(
    investigative,
    /checkpoint[\s\S]*(?:causas? competidoras|conocimiento (?:útil )?del usuario|autorización)/i,
  );
  assert.match(diagnostic, /instrumentación[\s\S]*(?:sensible|persistente)[\s\S]*autorización/i);
  assert.match(blocked, /señal intentada[\s\S]*límites? alcanzados[\s\S]*dato indispensable/i);
  assert.match(diagnostic, /reproducción original[\s\S]*(?:regresión|test)/i);
  assert.doesNotMatch(
    diagnostic + bugfix,
    /entre tres y cinco hipótesis|esfuerzo desproporcionado|agotar (?:todas )?las alternativas/i,
  );
  assert.match(bugfix, /clasificación[\s\S]*agentic-diagnostico-bugs/i);
});

test("la política reutiliza evidencia determinista solo mientras sigue vigente", async () => {
  const orchestration = await readFile(
    join(ROOT, ".agents", "policies", "orquestacion.md"),
    "utf8",
  );

  assert.match(orchestration, /## Estrategias de validación por unidad/);
  assert.match(orchestration, /`independent-rerun`[\s\S]*opción\s+segura por defecto/i);
  assert.match(orchestration, /`distinct-acceptance-check`[\s\S]*señal observable\s+distinta/i);
  assert.match(orchestration, /`verified-evidence-reuse`[\s\S]*autoriz\w*[\s\S]*antes de implementar/i);
  assert.match(orchestration, /señal (?:es )?rápida, determinista y local/i);
  assert.match(orchestration, /misma revisión base[\s\S]*ningún cambio posterior[\s\S]*rutas afectadas/i);
  assert.match(
    orchestration,
    /seguridad[\s\S]*integridad[\s\S]*migración[\s\S]*compatibilidad pública[\s\S]*concurrencia[\s\S]*no (?:se )?reutiliza/i,
  );
  assert.match(
    orchestration,
    /red[\s\S]*tiempo real[\s\S]*aleatoriedad[\s\S]*inspección visual[\s\S]*entorno compartido/i,
  );
  assert.match(
    orchestration,
    /cambio posterior relevante[\s\S]*reintento[\s\S]*dependencia[\s\S]*generación[\s\S]*obsoleta/i,
  );
});

test("los contratos separan la evidencia del Implementador del gate del Tester", async () => {
  const [orchestration, planner, implementer, tester] = await Promise.all([
    readFile(join(ROOT, ".agents", "policies", "orquestacion.md"), "utf8"),
    readFile(join(ROOT, ".agents", "roles", "planificador.md"), "utf8"),
    readFile(join(ROOT, ".agents", "roles", "implementador.md"), "utf8"),
    readFile(join(ROOT, ".agents", "roles", "tester.md"), "utf8"),
  ]);

  assert.match(planner, /seleccionar[\s\S]*estrategia\s+de validación[\s\S]*cada\s+unidad/i);
  assert.match(implementer, /revisión base[\s\S]*comando o procedimiento[\s\S]*resultado exacto[\s\S]*criterio cubierto/i);
  assert.match(tester, /revisar el diff[\s\S]*estrategia asignada/i);
  assert.match(
    tester,
    /\*\*Evidencia:\*\*[\s\S]*estrategia usada[\s\S]*evidencia revisada[\s\S]*ejecuciones propias[\s\S]*Omisiones/i,
  );
  assert.match(orchestration, /solo el Tester[\s\S]*marca la unidad como validada/i);
  assert.match(orchestration, /distinct-acceptance-check[\s\S]*responsabilidades distintas/i);
  assert.match(implementer, /No marcar la unidad como validada/i);
});

test("el cierre abre Documentador únicamente cuando existe una entrada real", async () => {
  const [orchestration, skill, documenter, ...workflows] = await Promise.all([
    readFile(join(ROOT, ".agents", "policies", "orquestacion.md"), "utf8"),
    readFile(join(ROOT, ".agents", "skills", "orquestar", "SKILL.md"), "utf8"),
    readFile(join(ROOT, ".agents", "roles", "documentador.md"), "utf8"),
    ...["feature", "bugfix", "refactor"].map((workflow) =>
      readFile(join(ROOT, ".agents", "workflows", `${workflow}.md`), "utf8"),
    ),
  ]);

  assert.match(orchestration, /## Gate condicional de Documentador/);
  assert.match(
    orchestration,
    /documentación vigente[\s\S]*contrato[\s\S]*decisión durable[\s\S]*candidato validado[\s\S]*Engram/i,
  );
  assert.match(orchestration, /interfaz[\s\S]*sigue\s+exigiendo\s+Documentador/i);
  assert.match(orchestration, /No aplica[\s\S]*motivo breve[\s\S]*no (?:abrir|crear)[^\n]*Documentador/i);
  assert.match(skill, /gate\s+de Documentador[\s\S]*No aplica/i);
  assert.match(documenter, /condición que abrió el gate/i);
  assert.match(documenter, /no se abre[\s\S]*certificar `No aplica`/i);
  for (const workflow of workflows) {
    assert.match(workflow, /Documentar[^\n]*condicional/i);
    assert.match(workflow, /política de orquestación/i);
  }
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
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "adopcion-controlador",
      description: "Comprueba la distribución del controlador.",
    }),
  });
  const codexHome = await createRepository();
  const adoption = runInitializer(repository);
  const activeSession = join(repository, ".agents", "sessions", "validacion-activa.md");
  await writeFile(activeSession, "# DevSession: validacion-activa\n", "utf8");
  try {
    const validation = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--dry-run",
      "--codex-config",
      "none",
    );

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
