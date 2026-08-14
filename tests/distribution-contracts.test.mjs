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
  assert.equal(manifest.scripts.test, "node --test");
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

test("los contratos canónicos enlazan políticas y exponen marcadores estables", async () => {
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

  const requiredPolicySections = [
    "Decisión de activación",
    "Modos",
    "Presupuesto y paralelismo controlado",
    "Estrategias de validación por unidad",
    "Gate condicional de Documentador",
    "Selección de workflow",
    "Delegación aislada",
    "DevSession",
    "Engram",
    "Cierre",
  ];
  for (const heading of requiredPolicySections) {
    assert.notEqual(markdownSection(orchestration, heading), null, `Falta la sección ${heading}.`);
  }

  const expectedPhases = {
    architecture: [
      { id: "architecture-explore", role: "explorador" },
      { id: "architecture-plan", role: "planificador" },
      { id: "architecture-propose", role: "documentador" },
      { id: "architecture-record", role: "documentador" },
    ],
    bugfix: [
      { id: "bugfix-reproduce", role: "tester" },
      { id: "bugfix-diagnose", role: "explorador" },
      { id: "bugfix-plan", role: "planificador" },
      { id: "bugfix-implement", role: "implementador" },
      { id: "bugfix-test", role: "tester" },
      { id: "bugfix-evaluate", role: "evaluador" },
      { id: "bugfix-document", role: "documentador" },
    ],
    feature: [
      { id: "feature-explore", role: "explorador" },
      { id: "feature-plan", role: "planificador" },
      { id: "feature-implement", role: "implementador" },
      { id: "feature-test", role: "tester" },
      { id: "feature-evaluate", role: "evaluador" },
      { id: "feature-document", role: "documentador" },
    ],
    refactor: [
      { id: "refactor-explore", role: "explorador" },
      { id: "refactor-plan", role: "planificador" },
      { id: "refactor-implement", role: "implementador" },
      { id: "refactor-test", role: "tester" },
      { id: "refactor-evaluate", role: "evaluador" },
      { id: "refactor-document", role: "documentador" },
    ],
  };
  for (const [workflow, source] of Object.entries(workflows)) {
    const phases = [...source.matchAll(/<!-- agentic-phase:v1 (\{[^\n]+\}) -->/g)].map(
      (match) => JSON.parse(match[1]),
    );
    assert.deepEqual(phases, expectedPhases[workflow]);
    assert.equal(
      linksToPolicy(source, "orquestacion.md"),
      true,
      `${workflow}.md no enlaza la política canónica.`,
    );
  }

  for (const [role, source] of Object.entries(roles)) {
    assert.deepEqual(
      [...source.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
      ["Misión", "Entradas", "Proceso", "Salida", "Límites"],
    );
    assert.equal(
      linksToPolicy(source, "orquestacion.md"),
      true,
      `${role}.md no enlaza la política canónica.`,
    );
  }

  assert.equal(linksToPolicy(skill, "orquestacion.md"), true);
  assert.ok(agentsContract.includes(".agents/policies/orquestacion.md"));
  assert.doesNotMatch(
    [skill, ...Object.values(roles), ...Object.values(workflows)].join("\n"),
    /architectural-decision|security-or-integrity|public-compatibility-or-migration|considerable-fan-in/,
  );
  assert.match(tdd, /un comportamiento observable por test[\s\S]*todas las aserciones[\s\S]*necesarias/i);
  assert.match(tdd, /refactor acotado[\s\S]*volver a ejecutar la validación focalizada/i);
  assert.doesNotMatch(tdd, /una aserción lógica por test/i);
  assert.match(
    agentsContract,
    /node --test --test-name-pattern="<patrón concreto del caso relacionado>"/,
  );
  assert.match(agentsContract, /- Completa: ejecutar `node --test`,/);
  assert.doesNotMatch(agentsContract, /node --test[^\n]*tests\/agentic-init\.test\.mjs/);
  for (const heading of [
    "Presupuesto y capacidad",
    "Unidades de implementación",
    "Evaluación final por ejes",
    "Índice compacto de reportes",
  ]) {
    assert.notEqual(markdownSection(devSession, heading), null, `Falta la sección ${heading}.`);
  }
  assert.ok(devSession.includes("evaluationStrategy"));
  assert.ok(devSession.includes("evaluationRisk"));
  assert.ok(subdevSession.includes("- Unidad: `<work-unit-id>`"));
  assert.ok(subdevSession.includes("- Permiso: `<permission>`"));
  assert.ok(codexAdapter.includes(".agents/roles/implementador.md"));
  assert.ok(claudeAdapter.includes(".agents/roles/implementador.md"));
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
  const activationSeam = markdownSection(agentsContract, "Activación y modo") ?? "";
  const decisionSeam = markdownSection(orchestration, "Decisión de activación") ?? "";

  assert.ok(activationSeam.includes(".agents/policies/orquestacion.md"));
  assert.deepEqual(
    [...decisionSeam.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((match) => Number(match[1])),
    [1, 2, 3, 4, 5, 6],
  );
  assert.doesNotMatch(
    [activationSeam, skill, claudeAdapter].join("\n"),
    /tareas? no triviales?|cambios?\s+multiarchivo|comportamiento nuevo/i,
  );
  assert.equal(
    orchestration.match(/^### Categorías de `full` automático$/gm)?.length,
    1,
  );
  assert.equal(linksToPolicy(skill, "orquestacion.md"), true);
  assert.ok(claudeAdapter.includes(".agents/skills/orquestar/SKILL.md"));
  assert.doesNotMatch(
    skill + claudeAdapter,
    /decisión arquitectónica durable|hipótesis competidoras|concurrencia de escritores/i,
  );

  assert.ok(readme.includes("| Directa verificada |"));
  assert.ok(readme.includes("| `light` |"));
  assert.ok(readme.includes("| `full` |"));
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

  assert.notEqual(markdownSection(orchestration, "Estrategias de validación por unidad"), null);
  assert.deepEqual(
    {
      implementer: roleOutputLabels(implementer),
      planner: roleOutputLabels(planner),
      tester: roleOutputLabels(tester),
    },
    {
      implementer: [
        "Archivos modificados",
        "Tareas completadas y pendientes",
        "Tests creados",
        "Validación ejecutada",
        "Desvíos o dudas",
        "Candidato a memoria",
      ],
      planner: [
        "Objetivo y comportamiento esperado",
        "Criterios de aceptación verificables",
        "No-objetivos y restricciones",
        "Puntos de integración y seams acordados",
        "Tareas ordenadas",
        "Validación",
        "Documentación esperada",
        "Decisiones pendientes",
        "Candidato a memoria",
      ],
      tester: ["Evidencia", "Tests creados", "Fallos", "Omisiones", "Candidato a memoria"],
    },
  );
  for (const source of [planner, implementer, tester]) {
    assert.equal(linksToPolicy(source, "orquestacion.md"), true);
  }
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

  const gate = markdownSection(orchestration, "Gate condicional de Documentador") ?? "";
  assert.equal([...gate.matchAll(/^- /gm)].length, 4);
  assert.ok(gate.includes("No aplica"));
  assert.equal(linksToPolicy(skill, "orquestacion.md"), true);
  assert.equal(linksToPolicy(documenter, "orquestacion.md"), true);
  assert.deepEqual(roleOutputLabels(documenter), [
    "Documentación modificada",
    "Sin cambios",
    "Memoria guardada",
    "Pendientes reales",
  ]);
  for (const [index, workflow] of workflows.entries()) {
    const name = ["feature", "bugfix", "refactor"][index];
    const phases = [...workflow.matchAll(/<!-- agentic-phase:v1 (\{[^\n]+\}) -->/g)].map(
      (match) => JSON.parse(match[1]),
    );
    assert.deepEqual(phases.at(-1), { id: `${name}-document`, role: "documentador" });
    assert.equal(linksToPolicy(workflow, "orquestacion.md"), true);
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
          markdownLinks(skill).some((target) =>
            target.split("#")[0].endsWith("/scripts/session-controller.mjs"),
          ),
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
