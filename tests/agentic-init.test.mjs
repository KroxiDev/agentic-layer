import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "agentic-init.mjs");
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
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
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const before = await snapshotDirectory(repository);

  const second = runInitializer(repository);
  assert.equal(second.status, 0, second.stderr || second.stdout);
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PLAN \(sin escrituras\)/);
  assert.match(result.stdout, /copiar: \.agents\/README\.md/);
  assert.match(result.stdout, /crear: AGENTS\.md/);
  assert.match(result.stdout, /Plan completo calculado sin escrituras/);
  assert.deepEqual(await snapshotDirectory(repository), before);
});

test("las herramientas externas ausentes producen advertencias y pendientes", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "sin-herramientas",
      description: "Funciona sin instalar dependencias o herramientas externas.",
    }),
  });

  const result = runInitializer(repository);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ADVERTENCIAS/);
  assert.match(result.stdout, /CodeGraph no está disponible/);
  assert.match(result.stdout, /Engram no está disponible/);
  assert.match(result.stdout, /ACCIONES MANUALES PENDIENTES/);
  assert.equal(existsSync(join(repository, "AGENTS.md")), true);
});

test("una copia de plantilla pregunta solo los hechos obligatorios no detectables", async () => {
  const [templateAgents, templateReadme] = await Promise.all([
    readFile(join(ROOT, "AGENTS.md"), "utf8"),
    readFile(join(ROOT, "README.md"), "utf8"),
  ]);
  const repository = await createRepository({
    ".git/HEAD": "ref: refs/heads/main\n",
    "AGENTS.md": templateAgents,
    "README.md": templateReadme,
  });
  const before = await snapshotDirectory(repository);

  const missingFacts = runInitializer(repository);

  assert.equal(missingFacts.status, 1, missingFacts.stderr || missingFacts.stdout);
  assert.match(missingFacts.stderr, /--purpose/);
  assert.deepEqual(await snapshotDirectory(repository), before);

  const initialized = runInitializer(
    repository,
    "--purpose",
    "Organiza notas de investigación locales.",
    "--git-strategy",
    "trabajar en ramas de tarea; no hacer push sin autorización.",
  );

  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const agents = await readFile(join(repository, "AGENTS.md"), "utf8");
  assert.match(agents, /Propósito: Organiza notas de investigación locales\./);
  assert.match(
    agents,
    /Rama o estrategia permitida: trabajar en ramas de tarea; no hacer push sin autorización\./,
  );
});

test("CodeGraph solo se inicializa o actualiza mediante confirmación explícita", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "codegraph-explicito",
      description: "Comprueba que las mutaciones opcionales requieren una bandera.",
    }),
  });

  const checkOnly = runInitializer(repository, "--dry-run");
  assert.equal(checkOnly.status, 0, checkOnly.stderr || checkOnly.stdout);
  assert.doesNotMatch(checkOnly.stdout, /inicializar CodeGraph|sincronizar CodeGraph/);

  const confirmed = runInitializer(repository, "--dry-run", "--init-codegraph");
  assert.equal(confirmed.status, 0, confirmed.stderr || confirmed.stdout);
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
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

  assert.equal(result.status, 0, result.stderr || result.stdout);
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
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.deepEqual(await snapshotDirectory(repository), initial);

  const applied = runInitializer(repository);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.match(applied.stdout, /integridad estructural de la distribución validada/);
  assert.match(applied.stdout, /Exclusiones locales de CodeGraph y Engram validadas/);
  const appliedSnapshot = await snapshotDirectory(repository);

  const repeated = runInitializer(repository);
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.deepEqual(await snapshotDirectory(repository), appliedSnapshot);

  assert.deepEqual(
    await readdir(join(repository, ".agents", "sessions")),
    [".gitignore"],
  );
});

test("la fuente canónica valida su contrato base sin marcarlo como una adopción", () => {
  const result = runInitializer(ROOT, "--dry-run");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /- validar: AGENTS\.md/);
  assert.doesNotMatch(result.stdout, /- actualizar: AGENTS\.md/);
});
