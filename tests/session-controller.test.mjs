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

test("session controller exige el contexto mínimo antes de abrir un sobre", async () => {
  const attempt = "feature-explore--explorador--a01";
  for (const [suffix, override, error] of [
    ["sin-objetivo", { objective: undefined }, "open_context_required"],
    ["objetivo-vacio", { objective: " \n" }, "open_context_required"],
    ["sin-reglas", { rules: undefined }, "open_context_required"],
    ["reglas-vacias", { rules: "\t" }, "open_context_required"],
    ["sin-tareas", { tasks: undefined }, "open_context_required"],
    ["tareas-vacias", { tasks: "" }, "open_context_required"],
    ["sin-hallazgos", { findings: undefined }, "open_context_required"],
    ["sin-rutas", { contextPaths: undefined }, "context_paths_required"],
  ]) {
    const fixture = await createManagedSession(`contexto-minimo-${suffix}`);
    const before = await readFile(fixture.globalPath, "utf8");
    const opened = runSessionController(
      fixture.repository,
      "open",
      {
        session: `contexto-minimo-${suffix}`,
        attempt,
        expectedRevision: 1,
      },
      { phaseId: "feature-explore", role: "explorador", ...override },
    );

    assert.deepEqual(controllerOutcome(opened), { code: 2, error });
    assert.equal(await readFile(fixture.globalPath, "utf8"), before);
    assert.equal(
      existsSync(
        join(
          fixture.repository,
          ".agents",
          "sessions",
          `contexto-minimo-${suffix}`,
          `${attempt}.md`,
        ),
      ),
      false,
    );
  }
});

test("session controller materializa un sobre de contexto mínimo autocontenido", async () => {
  const session = "contexto-minimo-autocontenido";
  const attempt = "feature-explore--explorador--a01";
  const fixture = await createManagedSession(session);
  const contextPaths = [
    ".agents/roles/explorador.md",
    ".agents/templates/subdev-session.md",
  ];
  const opened = runSessionController(
    fixture.repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    {
      contextPaths,
      findings: "No aplica",
      objective: "Delimitar el seam de contexto mínimo.",
      phaseId: "feature-explore",
      role: "explorador",
      rules: "Cadena efectiva: AGENTS.md; solo lectura.",
      tasks: "Identificar dependencias y devolver evidencia atribuible.",
    },
  );

  assert.equal(opened.status, 0, opened.stderr);
  const envelopeSource = await readFile(
    join(fixture.repository, ".agents", "sessions", session, `${attempt}.md`),
    "utf8",
  );
  const envelope = parseManagedState(envelopeSource);
  const global = parseManagedState(await readFile(fixture.globalPath, "utf8"));
  assert.equal(envelope.sourceRevision, 1);
  assert.deepEqual(envelope.contextPaths, contextPaths);
  assert.equal(global.attempts[attempt].sourceRevision, 1);
  assert.deepEqual(global.attempts[attempt].contextPaths, contextPaths);
  for (const expected of [
    "Delimitar el seam de contexto mínimo.",
    "Cadena efectiva: AGENTS.md; solo lectura.",
    "Identificar dependencias y devolver evidencia atribuible.",
    "## Rutas de contexto seleccionadas",
    "- Revisión fuente: `1`",
    ...contextPaths.map((path) => `- \`${path}\``),
  ]) {
    assert.match(envelopeSource, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(envelopeSource, /Según la DevSession global|DevSession global:/);
});

test("session controller calcula la revisión fuente del contexto mínimo", async () => {
  const session = "contexto-minimo-revision-fuente";
  const attempt = "feature-explore--explorador--a01";
  const fixture = await createManagedSession(session);
  const before = await readFile(fixture.globalPath, "utf8");
  const opened = runSessionController(
    fixture.repository,
    "open",
    { session, attempt, expectedRevision: 1 },
    {
      phaseId: "feature-explore",
      role: "explorador",
      sourceRevision: 99,
    },
  );

  assert.deepEqual(controllerOutcome(opened), {
    code: 2,
    error: "source_revision_is_managed",
  });
  assert.equal(await readFile(fixture.globalPath, "utf8"), before);
  assert.equal(
    existsSync(join(fixture.repository, ".agents", "sessions", session, `${attempt}.md`)),
    false,
  );
});

test("session controller rechaza rutas inseguras del contexto mínimo sin escribir", async () => {
  const attempt = "feature-explore--explorador--a01";
  const cases = [
    ["duplicada-portable", ["Docs/Plan.md", "docs/plan.md"], "duplicate_context_path"],
    ["absoluta-posix", ["/tmp/plan.md"], "invalid_context_path"],
    ["absoluta-windows", ["C:/temp/plan.md"], "invalid_context_path"],
    ["separador-windows", ["docs\\plan.md"], "invalid_context_path"],
    ["escape", ["docs/../AGENTS.md"], "invalid_context_path"],
    ["segmento-vacio", ["docs//plan.md"], "invalid_context_path"],
    ["alias-punto", ["docs/plan.md."], "invalid_context_path"],
    ["alias-espacio", ["docs/plan.md "], "invalid_context_path"],
    ["indice-protegido", [".codegraph/index.db"], "protected_context_path"],
    ["directorio-completo", [".agents/roles"], "invalid_context_path"],
  ];

  for (const [suffix, contextPaths, error] of cases) {
    const session = `contexto-minimo-ruta-${suffix}`;
    const fixture = await createManagedSession(session);
    const before = await readFile(fixture.globalPath, "utf8");
    const opened = runSessionController(
      fixture.repository,
      "open",
      { session, attempt, expectedRevision: 1 },
      { contextPaths, phaseId: "feature-explore", role: "explorador" },
    );

    assert.deepEqual(controllerOutcome(opened), { code: 2, error });
    assert.equal(await readFile(fixture.globalPath, "utf8"), before);
    assert.equal(
      existsSync(join(fixture.repository, ".agents", "sessions", session, `${attempt}.md`)),
      false,
    );
  }
});

test("session controller conserva el ciclo legacy previo al contexto mínimo", async () => {
  const session = "contexto-minimo-legacy";
  const attempt = "feature-implement--implementador--a01";
  const fixture = await createManagedAttempt(session, attempt);
  let legacySource = await readFile(fixture.envelopePath, "utf8");
  const legacyManaged = parseManagedState(legacySource);
  delete legacyManaged.contextPaths;
  delete legacyManaged.sourceRevision;
  legacySource = legacySource
    .replace("- Revisión fuente: `1`\n", "")
    .replace(
      "Aplicar las reglas efectivas indicadas para el intento.",
      "- Según la DevSession global.",
    )
    .replace(
      "Completar las tareas y criterios asignados al intento.",
      "- Según la DevSession global.",
    )
    .replace(/\n## Rutas de contexto seleccionadas\n[\s\S]*?(?=\n## Contrato de salida esperado)/, "");
  await writeFile(fixture.envelopePath, replaceManagedState(legacySource, legacyManaged), "utf8");

  const committed = runSessionController(
    fixture.repository,
    "commit",
    { session, attempt, expectedRevision: 2 },
    {
      report: [
        "- **Archivos modificados:** No aplica.",
        "- **Tareas completadas y pendientes:** completadas.",
        "- **Tests creados:** No aplica.",
        "- **Validación ejecutada:** comprobación legacy verde.",
        "- **Desvíos o dudas:** No aplica.",
        "- **Candidato a memoria:** No aplica.",
      ].join("\n"),
    },
  );
  const recovered = runSessionController(fixture.repository, "recover", { session });
  const cleaned = runSessionController(
    fixture.repository,
    "cleanup",
    { session, expectedRevision: 3 },
  );
  const closed = runSessionController(
    fixture.repository,
    "close",
    { session, expectedRevision: 4 },
  );

  assert.equal(committed.status, 0, committed.stderr);
  assert.deepEqual(controllerResponse(recovered).attempts, [
    { attempt, classification: "safe_to_delete", state: "completed" },
  ]);
  assert.deepEqual(controllerResponse(cleaned).deleted, [attempt]);
  assert.deepEqual(controllerResponse(closed), {
    command: "close",
    deleted: true,
    session,
    state: "completed",
  });
  assert.equal(existsSync(fixture.envelopePath), false);
  assert.equal(existsSync(fixture.globalPath), false);
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
      {
        isolationCapacity,
        mode: mode === "light" ? "full" : mode,
        platformCapacity,
        workUnits,
        workflow: "feature",
      },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    if (mode === "light") {
      const globalPath = join(repository, ".agents", "sessions", `${session}.md`);
      const source = await readFile(globalPath, "utf8");
      const managed = parseManagedState(source);
      managed.mode = "light";
      delete managed.lightStrategy;
      await writeFile(
        globalPath,
        replaceManagedState(source.replace("- Modo: full", "- Modo: light"), managed),
        "utf8",
      );
    }
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
  controller.stdin.end(
    JSON.stringify({
      contextPaths: [],
      findings: "No aplica",
      objective: "Comprobar la publicación atómica del writer lock.",
      phaseId: "feature-implement",
      role: "implementador",
      rules: "Aplicar las reglas efectivas del intento.",
      tasks: "Abrir el intento writer y publicar su reserva.",
    }),
  );

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

test("session controller completa feature y refactor en light compacto", async () => {
  const reports = {
    evaluador: [
      "- **Veredicto:** aprobado.",
      "- **Criterios verificados:** C01.",
      "- **Hallazgos:** Ninguno.",
      "- **Riesgo residual y evidencia faltante:** No aplica.",
      "- **Memoria guardada o candidata:** No aplica.",
    ].join("\n"),
    implementador: [
      "- **Archivos modificados:** cambio mínimo.",
      "- **Tareas completadas y pendientes:** completada.",
      "- **Tests creados:** permanentes.",
      "- **Validación ejecutada:** focalizada verde.",
      "- **Desvíos o dudas:** No aplica.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
    planificador: [
      "- **Objetivo y comportamiento esperado:** cambio acotado.",
      "- **Criterios de aceptación verificables:** C01.",
      "- **No-objetivos y restricciones:** una unidad.",
      "- **Puntos de integración y seams acordados:** CLI pública.",
      "- **Tareas ordenadas:** implementar y evaluar.",
      "- **Validación:** comando focalizado reproducible.",
      "- **Documentación esperada:** No aplica.",
      "- **Decisiones pendientes:** Ninguna.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
  };

  for (const workflow of ["feature", "refactor"]) {
    const repository = await createRepository();
    await seedSessionContracts(repository);
    const session = `${workflow}-light-compacto`;
    const plan = `${workflow}-plan--planificador--a01`;
    const implementation = `${workflow}-implement--implementador--a01`;
    const testing = `${workflow}-test--tester--a01`;
    const evaluation = `${workflow}-evaluate--evaluador--a01`;
    const tracedPayload = (phaseId, role, extra = {}) => ({
      baseRevision: "base",
      criteria: ["C01"],
      permission: role === "implementador" ? "writer" : "read-only",
      phaseId,
      role,
      threadId: `${role}-${workflow}`,
      ...extra,
    });

    const initialized = runSessionController(
      repository,
      "init",
      { session, expectedRevision: 0 },
      { mode: "light", workflow },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(
      controllerResponse(runSessionController(repository, "status", { session })).lightStrategy,
      "compact",
    );

    const omittedExplorer = runSessionController(
      repository,
      "open",
      {
        session,
        attempt: `${workflow}-explore--explorador--a01`,
        expectedRevision: 1,
      },
      tracedPayload(`${workflow}-explore`, "explorador"),
    );
    assert.deepEqual(controllerOutcome(omittedExplorer), {
      code: 1,
      error: "phase_not_in_light_sequence",
    });

    assert.equal(
      runSessionController(
        repository,
        "open",
        { session, attempt: plan, expectedRevision: 1 },
        tracedPayload(`${workflow}-plan`, "planificador"),
      ).status,
      0,
    );
    assert.equal(
      runSessionController(
        repository,
        "commit",
        { session, attempt: plan, expectedRevision: 2 },
        { report: reports.planificador },
      ).status,
      0,
    );
    const configured = runSessionController(
      repository,
      "init",
      { session, expectedRevision: 3 },
      {
        mode: "light",
        workUnits: [
          {
            acceptanceCriteria: ["C01"],
            dependsOn: [],
            focusedValidation: 'node --test --test-name-pattern="light compacto"',
            ownedPaths: ["src/unidad.mjs"],
            permission: "writer",
            workUnitId: "unidad",
          },
        ],
        workflow,
      },
    );
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(
      runSessionController(
        repository,
        "open",
        { session, attempt: implementation, expectedRevision: 4 },
        tracedPayload(`${workflow}-implement`, "implementador", { workUnitId: "unidad" }),
      ).status,
      0,
    );
    assert.equal(
      runSessionController(
        repository,
        "commit",
        { session, attempt: implementation, expectedRevision: 5 },
        { report: reports.implementador },
      ).status,
      0,
    );

    const omittedTester = runSessionController(
      repository,
      "open",
      { session, attempt: testing, expectedRevision: 6 },
      tracedPayload(`${workflow}-test`, "tester", { workUnitId: "unidad" }),
    );
    assert.deepEqual(controllerOutcome(omittedTester), {
      code: 1,
      error: "phase_not_in_light_sequence",
    });
    const evaluated = runSessionController(
      repository,
      "open",
      { session, attempt: evaluation, expectedRevision: 6 },
      tracedPayload(`${workflow}-evaluate`, "evaluador", {
        evaluationAxis: "combined",
        evaluationGeneration: 1,
        workUnitId: "unidad",
      }),
    );
    assert.equal(evaluated.status, 0, evaluated.stderr);
    assert.equal(
      runSessionController(
        repository,
        "commit",
        { session, attempt: evaluation, expectedRevision: 7 },
        { report: reports.evaluador },
      ).status,
      0,
    );

    const status = controllerResponse(runSessionController(repository, "status", { session }));
    assert.equal(status.fanInReady, true);
    assert.equal(status.finalEvaluation.approved, true);
    assert.deepEqual(
      status.workUnits.map(({ state, validated, workUnitId }) => ({
        state,
        validated,
        workUnitId,
      })),
      [{ state: "consolidated", validated: true, workUnitId: "unidad" }],
    );
    const cleaned = runSessionController(repository, "cleanup", {
      session,
      expectedRevision: 8,
    });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    const closed = runSessionController(repository, "close", {
      session,
      expectedRevision: 9,
    });
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(existsSync(join(repository, ".agents", "sessions", `${session}.md`)), false);
  }
});

test("session controller exige reproducción previa en bugfix light compacto", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "bugfix-light-compacto";
  const reproduce = "bugfix-reproduce--tester--a01";
  const plan = "bugfix-plan--planificador--a01";
  const implementation = "bugfix-implement--implementador--a01";
  const evaluation = "bugfix-evaluate--evaluador--a01";
  const tracedPayload = (phaseId, role, extra = {}) => ({
    baseRevision: "base",
    criteria: ["C03"],
    permission: role === "implementador" ? "writer" : "read-only",
    phaseId,
    role,
    threadId: `${role}-bugfix`,
    ...extra,
  });
  const reports = {
    evaluador: [
      "- **Veredicto:** aprobado.",
      "- **Criterios verificados:** C03.",
      "- **Hallazgos:** Ninguno.",
      "- **Riesgo residual y evidencia faltante:** No aplica.",
      "- **Memoria guardada o candidata:** No aplica.",
    ].join("\n"),
    implementador: [
      "- **Archivos modificados:** corrección mínima.",
      "- **Tareas completadas y pendientes:** completada.",
      "- **Tests creados:** regresión permanente.",
      "- **Validación ejecutada:** reproducción verde.",
      "- **Desvíos o dudas:** No aplica.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
    planificador: [
      "- **Objetivo y comportamiento esperado:** corregir la causa reproducida.",
      "- **Criterios de aceptación verificables:** C03.",
      "- **No-objetivos y restricciones:** una unidad determinista.",
      "- **Puntos de integración y seams acordados:** reproducción pública.",
      "- **Tareas ordenadas:** corregir y evaluar.",
      "- **Validación:** repetir la reproducción.",
      "- **Documentación esperada:** No aplica.",
      "- **Decisiones pendientes:** Ninguna.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
    tester: [
      "- **Evidencia:** reproducción mínima determinista.",
      "- **Tests creados:** regresión permanente.",
      "- **Fallos:** Ninguno.",
      "- **Omisiones:** Ninguna.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
  };

  assert.equal(
    runSessionController(
      repository,
      "init",
      { session, expectedRevision: 0 },
      { mode: "light", workflow: "bugfix" },
    ).status,
    0,
  );
  const planBeforeReproduction = runSessionController(
    repository,
    "open",
    { session, attempt: plan, expectedRevision: 1 },
    tracedPayload("bugfix-plan", "planificador"),
  );
  assert.deepEqual(controllerOutcome(planBeforeReproduction), {
    code: 1,
    error: "compact_phase_pending",
  });
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: reproduce, expectedRevision: 1 },
      tracedPayload("bugfix-reproduce", "tester"),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: reproduce, expectedRevision: 2 },
      { report: reports.tester },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: plan, expectedRevision: 3 },
      tracedPayload("bugfix-plan", "planificador"),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: plan, expectedRevision: 4 },
      { report: reports.planificador },
    ).status,
    0,
  );
  const configured = runSessionController(
    repository,
    "init",
    { session, expectedRevision: 5 },
    {
      mode: "light",
      workUnits: [
        {
          acceptanceCriteria: ["C03"],
          dependsOn: [],
          focusedValidation: "node --test --test-name-pattern=bugfix-light-compacto",
          ownedPaths: ["src/bug.mjs"],
          permission: "writer",
          workUnitId: "correccion",
        },
      ],
      workflow: "bugfix",
    },
  );
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: implementation, expectedRevision: 6 },
      tracedPayload("bugfix-implement", "implementador", { workUnitId: "correccion" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: implementation, expectedRevision: 7 },
      { report: reports.implementador },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: evaluation, expectedRevision: 8 },
      tracedPayload("bugfix-evaluate", "evaluador", {
        evaluationAxis: "combined",
        workUnitId: "correccion",
      }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: evaluation, expectedRevision: 9 },
      { report: reports.evaluador },
    ).status,
    0,
  );

  const status = controllerResponse(runSessionController(repository, "status", { session }));
  assert.equal(status.fanInReady, true);
  assert.deepEqual(
    new Set(status.attempts.map(({ attempt }) => attempt)),
    new Set([reproduce, plan, implementation, evaluation]),
  );
});

test("session controller hace fallar cerrado los contratos de light compacto", async () => {
  const planReport = (decisions = "Ninguna.") =>
    [
      "- **Objetivo y comportamiento esperado:** cambio acotado.",
      "- **Criterios de aceptación verificables:** C04 y C05.",
      "- **No-objetivos y restricciones:** una unidad sin riesgos excluidos.",
      "- **Puntos de integración y seams acordados:** CLI pública.",
      "- **Tareas ordenadas:** implementar y evaluar.",
      "- **Validación:** comando focalizado reproducible.",
      "- **Documentación esperada:** No aplica.",
      `- **Decisiones pendientes:** ${decisions}`,
      "- **Candidato a memoria:** No aplica.",
    ].join("\n");
  const implementationReport = [
    "- **Archivos modificados:** cambio mínimo.",
    "- **Tareas completadas y pendientes:** completada.",
    "- **Tests creados:** permanentes.",
    "- **Validación ejecutada:** focalizada verde.",
    "- **Desvíos o dudas:** No aplica.",
    "- **Candidato a memoria:** No aplica.",
  ].join("\n");
  const trace = (phaseId, role, extra = {}) => ({
    baseRevision: "base",
    criteria: ["C04", "C05"],
    permission: role === "implementador" ? "writer" : "read-only",
    phaseId,
    role,
    threadId: `${role}-contrato`,
    ...extra,
  });
  const unit = (overrides = {}) => ({
    acceptanceCriteria: ["C04", "C05"],
    dependsOn: [],
    focusedValidation: "node --test --test-name-pattern=light-compacto",
    ownedPaths: ["src/unidad.mjs"],
    permission: "writer",
    workUnitId: "unidad",
    ...overrides,
  });

  async function createPlannedSession(session) {
    const repository = await createRepository();
    await seedSessionContracts(repository);
    assert.equal(
      runSessionController(
        repository,
        "init",
        { session, expectedRevision: 0 },
        { mode: "light", workflow: "feature" },
      ).status,
      0,
    );
    assert.equal(
      runSessionController(
        repository,
        "open",
        { session, attempt: "feature-plan--planificador--a01", expectedRevision: 1 },
        trace("feature-plan", "planificador"),
      ).status,
      0,
    );
    assert.equal(
      runSessionController(
        repository,
        "commit",
        { session, attempt: "feature-plan--planificador--a01", expectedRevision: 2 },
        { report: planReport() },
      ).status,
      0,
    );
    return repository;
  }

  const pendingRepository = await createRepository();
  await seedSessionContracts(pendingRepository);
  const pendingSession = "light-compacto-decision-pendiente";
  assert.equal(
    runSessionController(
      pendingRepository,
      "init",
      { session: pendingSession, expectedRevision: 0 },
      { mode: "light", workflow: "feature" },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      pendingRepository,
      "open",
      {
        session: pendingSession,
        attempt: "feature-plan--planificador--a01",
        expectedRevision: 1,
      },
      trace("feature-plan", "planificador"),
    ).status,
    0,
  );
  const pendingCommit = runSessionController(
    pendingRepository,
    "commit",
    {
      session: pendingSession,
      attempt: "feature-plan--planificador--a01",
      expectedRevision: 2,
    },
    { report: planReport("Elegir un seam.") },
  );
  assert.deepEqual(controllerOutcome(pendingCommit), {
    code: 1,
    error: "compact_light_ineligible",
  });

  const invalidPlans = [
    { error: "invalid_compact_work_units", name: "cero", workUnits: [] },
    {
      error: "invalid_compact_work_units",
      name: "multiples",
      workUnits: [unit(), unit({ ownedPaths: ["src/otra.mjs"], workUnitId: "otra" })],
    },
    {
      error: "ownership_collision",
      name: "ownership",
      workUnits: [unit({ ownedPaths: ["src/unidad.mjs", "SRC/unidad.mjs. "] })],
    },
    {
      error: "invalid_compact_work_unit",
      name: "sin-validacion",
      workUnits: [unit({ focusedValidation: undefined })],
    },
    {
      error: "invalid_compact_work_unit",
      name: "sin-writer",
      workUnits: [unit({ permission: "read-only" })],
    },
    {
      error: "invalid_compact_work_unit",
      name: "sin-ownership",
      workUnits: [unit({ ownedPaths: [] })],
    },
  ];
  for (const fixture of invalidPlans) {
    const session = `light-compacto-${fixture.name}`;
    const repository = await createPlannedSession(session);
    const configured = runSessionController(
      repository,
      "init",
      { session, expectedRevision: 3 },
      { mode: "light", workUnits: fixture.workUnits, workflow: "feature" },
    );
    assert.deepEqual(controllerOutcome(configured), { code: 2, error: fixture.error });
  }

  const unconfiguredSession = "light-compacto-sin-unidad";
  const unconfiguredRepository = await createPlannedSession(unconfiguredSession);
  const implementationWithoutUnit = runSessionController(
    unconfiguredRepository,
    "open",
    {
      session: unconfiguredSession,
      attempt: "feature-implement--implementador--a01",
      expectedRevision: 3,
    },
    trace("feature-implement", "implementador"),
  );
  assert.deepEqual(controllerOutcome(implementationWithoutUnit), {
    code: 2,
    error: "work_unit_required",
  });

  const markerSession = "light-compacto-marker-invalido";
  const markerRepository = await createPlannedSession(markerSession);
  assert.equal(
    runSessionController(
      markerRepository,
      "init",
      { session: markerSession, expectedRevision: 3 },
      { mode: "light", workUnits: [unit()], workflow: "feature" },
    ).status,
    0,
  );
  const workflowPath = join(markerRepository, ".agents", "workflows", "feature.md");
  await writeFile(
    workflowPath,
    (await readFile(workflowPath, "utf8")).replace(
      /<!-- agentic-light-sequence:v1 \{[^\n]+\} -->/,
      '<!-- agentic-light-sequence:v1 {"phases":["fase-inexistente"]} -->',
    ),
    "utf8",
  );
  const invalidMarker = runSessionController(
    markerRepository,
    "open",
    {
      session: markerSession,
      attempt: "feature-implement--implementador--a01",
      expectedRevision: 4,
    },
    trace("feature-implement", "implementador", { workUnitId: "unidad" }),
  );
  assert.deepEqual(controllerOutcome(invalidMarker), {
    code: 1,
    error: "invalid_light_sequence",
  });

  const architectureRepository = await createRepository();
  await seedSessionContracts(architectureRepository);
  const architecture = runSessionController(
    architectureRepository,
    "init",
    { session: "architecture-light", expectedRevision: 0 },
    { mode: "light", workflow: "architecture" },
  );
  assert.deepEqual(controllerOutcome(architecture), {
    code: 2,
    error: "compact_light_unsupported_workflow",
  });

  const fullRepository = await createRepository();
  await seedSessionContracts(fullRepository);
  const full = runSessionController(
    fullRepository,
    "init",
    { session: "full-sin-cambios", expectedRevision: 0 },
    {
      mode: "full",
      workUnits: [
        {
          acceptanceCriteria: ["C08"],
          dependsOn: [],
          ownedPaths: ["src/uno.mjs"],
          permission: "writer",
          workUnitId: "uno",
        },
        {
          acceptanceCriteria: ["C08"],
          dependsOn: [],
          ownedPaths: ["src/dos.mjs"],
          permission: "writer",
          workUnitId: "dos",
        },
      ],
      workflow: "feature",
    },
  );
  assert.equal(full.status, 0, full.stderr);
  assert.equal(
    controllerResponse(
      runSessionController(fullRepository, "status", { session: "full-sin-cambios" }),
    ).lightStrategy,
    undefined,
  );

  const evaluationSession = "light-compacto-evaluador";
  const evaluationRepository = await createPlannedSession(evaluationSession);
  const configured = runSessionController(
    evaluationRepository,
    "init",
    { session: evaluationSession, expectedRevision: 3 },
    { mode: "light", workUnits: [unit()], workflow: "feature" },
  );
  assert.equal(configured.status, 0, configured.stderr);
  const evaluationAttempt = "feature-evaluate--evaluador--a01";
  const beforeImplementation = runSessionController(
    evaluationRepository,
    "open",
    { session: evaluationSession, attempt: evaluationAttempt, expectedRevision: 4 },
    trace("feature-evaluate", "evaluador", {
      evaluationAxis: "combined",
      workUnitId: "unidad",
    }),
  );
  assert.deepEqual(controllerOutcome(beforeImplementation), {
    code: 1,
    error: "compact_phase_pending",
  });
  const implementation = "feature-implement--implementador--a01";
  assert.equal(
    runSessionController(
      evaluationRepository,
      "open",
      { session: evaluationSession, attempt: implementation, expectedRevision: 4 },
      trace("feature-implement", "implementador", { workUnitId: "unidad" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      evaluationRepository,
      "commit",
      { session: evaluationSession, attempt: implementation, expectedRevision: 5 },
      { report: implementationReport },
    ).status,
    0,
  );
  const invalidEvaluations = [
    {
      error: "work_unit_required",
      payload: trace("feature-evaluate", "evaluador", { evaluationAxis: "combined" }),
    },
    {
      error: "invalid_attempt_permission",
      payload: trace("feature-evaluate", "evaluador", {
        evaluationAxis: "combined",
        permission: "writer",
        workUnitId: "unidad",
      }),
    },
    {
      error: "invalid_evaluation_axis",
      payload: trace("feature-evaluate", "evaluador", {
        evaluationAxis: "standards",
        workUnitId: "unidad",
      }),
    },
    {
      error: "stale_evaluation_generation",
      payload: trace("feature-evaluate", "evaluador", {
        evaluationAxis: "combined",
        evaluationGeneration: 0,
        workUnitId: "unidad",
      }),
    },
  ];
  for (const fixture of invalidEvaluations) {
    const opened = runSessionController(
      evaluationRepository,
      "open",
      { session: evaluationSession, attempt: evaluationAttempt, expectedRevision: 6 },
      fixture.payload,
    );
    assert.deepEqual(controllerOutcome(opened), { code: 2, error: fixture.error });
  }
  const validEvaluation = runSessionController(
    evaluationRepository,
    "open",
    { session: evaluationSession, attempt: evaluationAttempt, expectedRevision: 6 },
    trace("feature-evaluate", "evaluador", {
      evaluationAxis: "combined",
      evaluationGeneration: 1,
      workUnitId: "unidad",
    }),
  );
  assert.equal(validEvaluation.status, 0, validEvaluation.stderr);
});

test("session controller retrabaja light compacto y conserva sesiones light legacy", async () => {
  const reports = {
    approved: [
      "- **Veredicto:** aprobado.",
      "- **Criterios verificados:** C07.",
      "- **Hallazgos:** Ninguno.",
      "- **Riesgo residual y evidencia faltante:** No aplica.",
      "- **Memoria guardada o candidata:** No aplica.",
    ].join("\n"),
    changesRequired: [
      "- **Veredicto:** cambios requeridos.",
      "- **Criterios verificados:** C07 incompleto.",
      "- **Hallazgos:** falta ajustar el resultado.",
      "- **Riesgo residual y evidencia faltante:** evidencia focalizada incompleta.",
      "- **Memoria guardada o candidata:** No aplica.",
    ].join("\n"),
    implementador: [
      "- **Archivos modificados:** cambio mínimo.",
      "- **Tareas completadas y pendientes:** completada.",
      "- **Tests creados:** permanentes.",
      "- **Validación ejecutada:** focalizada verde.",
      "- **Desvíos o dudas:** No aplica.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
    planificador: [
      "- **Objetivo y comportamiento esperado:** cambio acotado.",
      "- **Criterios de aceptación verificables:** C07.",
      "- **No-objetivos y restricciones:** una unidad.",
      "- **Puntos de integración y seams acordados:** CLI pública.",
      "- **Tareas ordenadas:** implementar y evaluar.",
      "- **Validación:** comando focalizado reproducible.",
      "- **Documentación esperada:** No aplica.",
      "- **Decisiones pendientes:** Ninguna.",
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
  const trace = (phaseId, role, criteria, extra = {}) => ({
    baseRevision: "base",
    criteria,
    permission: role === "implementador" ? "writer" : "read-only",
    phaseId,
    role,
    threadId: `${role}-${phaseId}`,
    ...extra,
  });

  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "light-compacto-retrabajo";
  const plan = "feature-plan--planificador--a01";
  const implementation = "feature-implement--implementador--a01";
  const evaluation = "feature-evaluate--evaluador--a01";
  assert.equal(
    runSessionController(
      repository,
      "init",
      { session, expectedRevision: 0 },
      { mode: "light", workflow: "feature" },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: plan, expectedRevision: 1 },
      trace("feature-plan", "planificador", ["C07"]),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: plan, expectedRevision: 2 },
      { report: reports.planificador },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "init",
      { session, expectedRevision: 3 },
      {
        mode: "light",
        workUnits: [
          {
            acceptanceCriteria: ["C07"],
            dependsOn: [],
            focusedValidation: "node --test --test-name-pattern=retrabajo-light-compacto",
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
      { session, attempt: implementation, expectedRevision: 4 },
      trace("feature-implement", "implementador", ["C07"], { workUnitId: "unidad" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: implementation, expectedRevision: 5 },
      { report: reports.implementador },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: evaluation, expectedRevision: 6 },
      trace("feature-evaluate", "evaluador", ["C07"], {
        evaluationAxis: "combined",
        workUnitId: "unidad",
      }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: evaluation, expectedRevision: 7 },
      { report: reports.changesRequired },
    ).status,
    0,
  );
  let status = controllerResponse(runSessionController(repository, "status", { session }));
  assert.equal(status.fanInReady, false);
  assert.equal(status.finalEvaluation.axes.combined, "changes_required");
  assert.equal(status.workUnits[0].state, "failed");

  const rework = "feature-implement--implementador--a02";
  const reopened = runSessionController(
    repository,
    "open",
    { session, attempt: rework, expectedRevision: 8 },
    trace("feature-implement", "implementador", ["C07"], {
      cause: "El Evaluador pidió ajustar el resultado.",
      previousAttempt: implementation,
      workUnitId: "unidad",
    }),
  );
  assert.equal(reopened.status, 0, reopened.stderr);
  status = controllerResponse(runSessionController(repository, "status", { session }));
  assert.equal(status.finalEvaluation.generation, 2);
  assert.equal(status.finalEvaluation.axes.combined, "pending");
  assert.equal(
    runSessionController(
      repository,
      "commit",
      { session, attempt: rework, expectedRevision: 9 },
      { report: reports.implementador },
    ).status,
    0,
  );
  const evaluationRetry = "feature-evaluate--evaluador--a02";
  assert.equal(
    runSessionController(
      repository,
      "open",
      { session, attempt: evaluationRetry, expectedRevision: 10 },
      trace("feature-evaluate", "evaluador", ["C07"], {
        cause: "Se evalúa el retrabajo.",
        evaluationAxis: "combined",
        evaluationGeneration: 2,
        previousAttempt: evaluation,
        workUnitId: "unidad",
      }),
    ).status,
    0,
  );
  const approved = runSessionController(
    repository,
    "commit",
    { session, attempt: evaluationRetry, expectedRevision: 11 },
    { report: reports.approved },
  );
  assert.equal(approved.status, 0, approved.stderr);
  const repeated = runSessionController(
    repository,
    "commit",
    { session, attempt: evaluationRetry, expectedRevision: 12 },
    { report: reports.approved },
  );
  assert.equal(controllerResponse(repeated).idempotent, true);
  status = controllerResponse(runSessionController(repository, "status", { session }));
  assert.equal(status.fanInReady, true);
  assert.equal(status.finalEvaluation.approved, true);
  assert.equal(status.finalEvaluation.generation, 2);

  const legacyRepository = await createRepository();
  await seedSessionContracts(legacyRepository);
  const legacySession = "light-legacy-separado";
  assert.equal(
    runSessionController(
      legacyRepository,
      "init",
      { session: legacySession, expectedRevision: 0 },
      { mode: "light", workflow: "feature" },
    ).status,
    0,
  );
  const legacyPath = join(legacyRepository, ".agents", "sessions", `${legacySession}.md`);
  const legacySource = await readFile(legacyPath, "utf8");
  const legacyManaged = parseManagedState(legacySource);
  delete legacyManaged.lightStrategy;
  await writeFile(legacyPath, replaceManagedState(legacySource, legacyManaged), "utf8");
  assert.equal(
    runSessionController(
      legacyRepository,
      "init",
      { session: legacySession, expectedRevision: 1 },
      {
        mode: "light",
        workUnits: [
          {
            acceptanceCriteria: ["C09"],
            dependsOn: [],
            ownedPaths: ["src/legacy.mjs"],
            permission: "writer",
            workUnitId: "legacy",
          },
        ],
        workflow: "feature",
      },
    ).status,
    0,
  );
  const legacyImplementation = "feature-implement--implementador--a01";
  const legacyTesting = "feature-test--tester--a01";
  const legacyEvaluation = "feature-evaluate--evaluador--a01";
  assert.equal(
    runSessionController(
      legacyRepository,
      "open",
      { session: legacySession, attempt: legacyImplementation, expectedRevision: 2 },
      trace("feature-implement", "implementador", ["C09"], { workUnitId: "legacy" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      legacyRepository,
      "commit",
      { session: legacySession, attempt: legacyImplementation, expectedRevision: 3 },
      { report: reports.implementador },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      legacyRepository,
      "open",
      { session: legacySession, attempt: legacyTesting, expectedRevision: 4 },
      trace("feature-test", "tester", ["C09"], { workUnitId: "legacy" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      legacyRepository,
      "commit",
      { session: legacySession, attempt: legacyTesting, expectedRevision: 5 },
      { report: reports.tester },
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      legacyRepository,
      "open",
      { session: legacySession, attempt: legacyEvaluation, expectedRevision: 6 },
      trace("feature-evaluate", "evaluador", ["C09"], { evaluationAxis: "combined" }),
    ).status,
    0,
  );
  assert.equal(
    runSessionController(
      legacyRepository,
      "commit",
      { session: legacySession, attempt: legacyEvaluation, expectedRevision: 7 },
      { report: reports.approved },
    ).status,
    0,
  );
  const legacyStatus = controllerResponse(
    runSessionController(legacyRepository, "status", { session: legacySession }),
  );
  assert.equal(legacyStatus.lightStrategy, undefined);
  assert.equal(legacyStatus.fanInReady, true);
  assert.equal(legacyStatus.finalEvaluation.approved, true);
  assert.equal(
    controllerResponse(
      runSessionController(legacyRepository, "recover", { session: legacySession }),
    ).attempts.length,
    3,
  );
  assert.equal(
    runSessionController(legacyRepository, "cleanup", {
      session: legacySession,
      expectedRevision: 8,
    }).status,
    0,
  );
  assert.equal(
    runSessionController(legacyRepository, "close", {
      session: legacySession,
      expectedRevision: 9,
    }).status,
    0,
  );
});

test("session controller limita a dos ciclos el retrabajo de light compacto", async () => {
  const repository = await createRepository();
  await seedSessionContracts(repository);
  const session = "light-compacto-dos-ciclos";
  const reports = {
    changesRequired: [
      "- **Veredicto:** cambios requeridos.",
      "- **Criterios verificados:** C07 incompleto.",
      "- **Hallazgos:** persiste el mismo hallazgo.",
      "- **Riesgo residual y evidencia faltante:** falta evidencia.",
      "- **Memoria guardada o candidata:** No aplica.",
    ].join("\n"),
    implementador: [
      "- **Archivos modificados:** retrabajo mínimo.",
      "- **Tareas completadas y pendientes:** completada.",
      "- **Tests creados:** permanentes.",
      "- **Validación ejecutada:** focalizada verde.",
      "- **Desvíos o dudas:** No aplica.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
    planificador: [
      "- **Objetivo y comportamiento esperado:** cambio acotado.",
      "- **Criterios de aceptación verificables:** C07.",
      "- **No-objetivos y restricciones:** dos ciclos como máximo.",
      "- **Puntos de integración y seams acordados:** CLI pública.",
      "- **Tareas ordenadas:** implementar y evaluar.",
      "- **Validación:** comando focalizado reproducible.",
      "- **Documentación esperada:** No aplica.",
      "- **Decisiones pendientes:** Ninguna.",
      "- **Candidato a memoria:** No aplica.",
    ].join("\n"),
  };
  const trace = (phaseId, role, extra = {}) => ({
    baseRevision: "base",
    criteria: ["C07"],
    permission: role === "implementador" ? "writer" : "read-only",
    phaseId,
    role,
    threadId: `${role}-${phaseId}`,
    ...extra,
  });
  let revision = 0;
  function succeed(command, attempt, payload) {
    const result = runSessionController(
      repository,
      command,
      { session, ...(attempt ? { attempt } : {}), expectedRevision: revision },
      payload,
    );
    assert.equal(result.status, 0, result.stderr);
    revision = controllerResponse(result).revision;
  }

  succeed("init", undefined, { mode: "light", workflow: "feature" });
  const plan = "feature-plan--planificador--a01";
  succeed("open", plan, trace("feature-plan", "planificador"));
  succeed("commit", plan, { report: reports.planificador });
  succeed("init", undefined, {
    mode: "light",
    workUnits: [
      {
        acceptanceCriteria: ["C07"],
        dependsOn: [],
        focusedValidation: "node --test --test-name-pattern=dos-ciclos",
        ownedPaths: ["src/unidad.mjs"],
        permission: "writer",
        workUnitId: "unidad",
      },
    ],
    workflow: "feature",
  });
  let implementation = "feature-implement--implementador--a01";
  succeed(
    "open",
    implementation,
    trace("feature-implement", "implementador", { workUnitId: "unidad" }),
  );
  succeed("commit", implementation, { report: reports.implementador });

  let evaluation;
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const previousEvaluation = evaluation;
    evaluation = `feature-evaluate--evaluador--a0${cycle}`;
    succeed(
      "open",
      evaluation,
      trace("feature-evaluate", "evaluador", {
        ...(previousEvaluation
          ? { cause: "Se evalúa el retrabajo.", previousAttempt: previousEvaluation }
          : {}),
        evaluationAxis: "combined",
        evaluationGeneration: cycle,
        workUnitId: "unidad",
      }),
    );
    succeed("commit", evaluation, { report: reports.changesRequired });
    if (cycle === 3) break;
    const previousImplementation = implementation;
    implementation = `feature-implement--implementador--a0${cycle + 1}`;
    succeed(
      "open",
      implementation,
      trace("feature-implement", "implementador", {
        cause: "El Evaluador solicitó cambios.",
        previousAttempt: previousImplementation,
        workUnitId: "unidad",
      }),
    );
    succeed("commit", implementation, { report: reports.implementador });
  }

  const blocked = runSessionController(
    repository,
    "open",
    {
      session,
      attempt: "feature-implement--implementador--a04",
      expectedRevision: revision,
    },
    trace("feature-implement", "implementador", {
      cause: "Persisten cambios requeridos.",
      previousAttempt: implementation,
      workUnitId: "unidad",
    }),
  );
  assert.deepEqual(controllerOutcome(blocked), {
    code: 1,
    error: "compact_rework_limit",
  });
});
