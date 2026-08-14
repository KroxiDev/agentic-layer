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
} from "./agentic-test-helpers.mjs";

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
  assert.deepEqual(await snapshotDirectory(external), externalBefore);

  const movedAgents = (await readdir(repository)).find((entry) =>
    entry.startsWith(".agents.agentic-rollback-original-"),
  );
  assert.ok(movedAgents, await readdir(repository));
  await unlink(join(repository, ".agents"));
  await rename(join(repository, movedAgents), join(repository, ".agents"));
});
