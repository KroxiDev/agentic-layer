import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "agentic-init.mjs");
const BIN = join(ROOT, "bin", "agentic.mjs");
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

export {
  CLI,
  ROOT,
  SIN_HERRAMIENTAS,
  countPendingFields,
  createRepository,
  linksToPolicy,
  markdownLinks,
  markdownSection,
  roleOutputLabels,
  runExecutable,
  runExecutableWithEnvironment,
  runInitializer,
  runInitializerWithoutFlags,
  runInteractiveUpdate,
  snapshotDirectory,
};
