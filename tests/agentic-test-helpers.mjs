import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "agentic-init.mjs");
const BIN = join(ROOT, "bin", "agentic.mjs");
const SESSION_CONTROLLER = join(ROOT, ".agents", "scripts", "session-controller.mjs");
// Las simulaciones se ejecutan con un PATH vacío, así que toda adopción
// completa informa CodeGraph y Engram ausentes y sale con el código 4.
const SIN_HERRAMIENTAS = 4;
const TEST_TEMP_ROOT = mkdtempSync(join(tmpdir(), "agentic-tests-"));

function testEnvironment(environment = {}) {
  return {
    ...process.env,
    TEMP: TEST_TEMP_ROOT,
    TMP: TEST_TEMP_ROOT,
    TMPDIR: TEST_TEMP_ROOT,
    ...environment,
  };
}

after(async () => {
  await rm(TEST_TEMP_ROOT, { recursive: true, force: true });
});

async function createRepository(files = {}) {
  const directory = await mkdtemp(join(TEST_TEMP_ROOT, "repository-"));

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
      env: testEnvironment({ PATH: "" }),
    },
  );
}

// Sin banderas y sin TTY: exactamente el caso ideal de adopción con un solo
// comando, en el que el inicializador no puede preguntar nada.
function runInitializerWithoutFlags(directory) {
  return spawnSync(process.execPath, [CLI, "--target", directory], {
    cwd: ROOT,
    encoding: "utf8",
    env: testEnvironment({ PATH: "" }),
  });
}

function countPendingFields(contract) {
  return contract.match(/<pendiente: [^>]+>/g)?.length ?? 0;
}

function markdownLinks(source) {
  return [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) =>
    match[1].trim().replace(/^<|>$/g, "").replaceAll("\\", "/"),
  );
}

function linksToPolicy(source, policy) {
  return markdownLinks(source).some(
    (target) => target.split("#")[0].endsWith(`policies/${policy}`),
  );
}

function markdownSection(source, heading) {
  const marker = `## ${heading}`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const contentStart = start + marker.length;
  const next = source.indexOf("\n## ", contentStart);
  return source.slice(contentStart, next < 0 ? source.length : next);
}

function roleOutputLabels(source) {
  return [...(markdownSection(source, "Salida") ?? "").matchAll(/^- \*\*([^*]+?):\*\*/gm)].map(
    (match) => match[1],
  );
}

function runExecutable(...arguments_) {
  return spawnSync(process.execPath, [BIN, ...arguments_], {
    cwd: ROOT,
    encoding: "utf8",
    env: testEnvironment({ PATH: "" }),
  });
}

function runExecutableWithEnvironment(environment, ...arguments_) {
  return spawnSync(process.execPath, [BIN, ...arguments_], {
    cwd: ROOT,
    encoding: "utf8",
    env: testEnvironment({ PATH: "", ...environment }),
  });
}

async function runInteractiveExecutableWithEnvironment(environment, answers, ...arguments_) {
  const child = spawn(process.execPath, [BIN, ...arguments_], {
    cwd: ROOT,
    env: testEnvironment({
      PATH: "",
      AGENTIC_INIT_TEST_FORCE_TTY: "1",
      ...environment,
    }),
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

export {
  BIN,
  CLI,
  ROOT,
  SESSION_CONTROLLER,
  SIN_HERRAMIENTAS,
  controllerOutcome,
  controllerResponse,
  countPendingFields,
  createManagedAttempt,
  createManagedSession,
  createPreTraceWorkUnitSession,
  createRepository,
  linksToPolicy,
  markdownLinks,
  markdownSection,
  parseManagedState,
  replaceManagedState,
  roleOutputLabels,
  runExecutable,
  runExecutableWithEnvironment,
  runInitializer,
  runInitializerWithoutFlags,
  runInteractiveExecutableWithEnvironment,
  runInteractiveUpdate,
  runSessionController,
  seedSessionContracts,
  snapshotDirectory,
};
