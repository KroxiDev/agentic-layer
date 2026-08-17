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

import {
  BIN,
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
  runInteractiveExecutableWithEnvironment,
  runInteractiveUpdate,
  snapshotDirectory,
} from "./agentic-test-helpers.mjs";

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

test("distribuye la Regla de Oro y alinea sus consumidores con el refactor TDD", async () => {
  const policyReference = ".agents/policies/regla-de-oro.md";
  const consumers = ["planificador", "implementador", "tester", "evaluador"];
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const rootAgents = await readFile(join(ROOT, "AGENTS.md"), "utf8");
  const goldenRule = await readFile(join(ROOT, ...policyReference.split("/")), "utf8");
  const orchestration = await readFile(
    join(ROOT, ".agents", "policies", "orquestacion.md"),
    "utf8",
  );
  const sddTdd = await readFile(join(ROOT, ".agents", "policies", "sdd-tdd.md"), "utf8");
  const tddSkill = await readFile(
    join(ROOT, ".agents", "skills", "agentic-tdd", "SKILL.md"),
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
      globalActivation: markdownSection(rootAgents, "Desarrollo")?.includes(policyReference),
      canonicalPolicyRegistered: orchestration.includes(policyReference),
      roleReferences: Object.fromEntries(
        consumers.map((role, index) => [role, roleContents[index].includes(policyReference)]),
      ),
    },
    {
      policyPresent: true,
      templateInventory: true,
      packageInventory: true,
      globalActivation: true,
      canonicalPolicyRegistered: true,
      roleReferences: {
        planificador: true,
        implementador: true,
        tester: true,
        evaluador: true,
      },
    },
  );

  assert.match(goldenRule, /refactor local habilitante[\s\S]*refactor oportunista/i);
  assert.match(
    goldenRule,
    /tres repeticiones[\s\S]{0,160}revisi[oó]n[\s\S]{0,160}no una extracci[oó]n autom[aá]tica/i,
  );
  assert.match(
    goldenRule,
    /invariante compartida estable[\s\S]*reduce (?:la )?interface o el conocimiento[\s\S]*(?:leverage|localidad)/i,
  );
  assert.match(goldenRule, /un solo (?:caller|adapter)[\s\S]*no justifica/i);
  assert.match(goldenRule, /dos adapters[\s\S]*seam real/i);
  assert.match(
    sddTdd,
    /refactor local habilitante[\s\S]*mismo ciclo[\s\S]*validaci[oó]n focalizada/i,
  );
  assert.match(
    tddSkill,
    /refactor local habilitante[\s\S]*rutas autorizadas[\s\S]*volver a ejecutar la validaci[oó]n focalizada/i,
  );
  assert.match(
    roleContents[1],
    /refactor local habilitante[\s\S]*reportar[\s\S]*validaci[oó]n focalizada posterior/i,
  );
  assert.match(
    roleContents[3],
    /duplicaci[oó]n incidental[\s\S]*un solo (?:caller|adapter)[\s\S]*abstracci[oó]n gratuita/i,
  );
  assert.doesNotMatch(
    [goldenRule, sddTdd, tddSkill, ...roleContents].join("\n"),
    /no borrar ni refactorizar c[oó]digo\s+existente|a la tercera repetici[oó]n del mismo bloque, extraer/i,
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
