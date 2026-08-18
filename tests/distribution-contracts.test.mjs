import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

import { PACKAGE_FILES, TEMPLATE_FILES } from "../scripts/agentic-init.mjs";

import {
  ROOT,
  SIN_HERRAMIENTAS,
  createRepository,
  linksToPolicy,
  markdownLinks,
  markdownSection,
  roleOutputLabels,
  runExecutableWithEnvironment,
  runInitializer,
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

test("el inicializador deriva del protocolo el inventario instalado y empaquetado", async () => {
  const protocol = JSON.parse(
    await readFile(join(ROOT, ".agents", "protocol.json"), "utf8"),
  );
  const installed = protocol.artifacts.map((artifact) => artifact.path);
  const packaged = [
    ...protocol.artifacts.map((artifact) => artifact.source ?? artifact.path),
    ...protocol.distributionSupportFiles,
  ].sort();

  assert.deepEqual(TEMPLATE_FILES, installed);
  assert.deepEqual(PACKAGE_FILES, packaged);
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

test("el check sintáctico deriva del inventario distribuido autoritativo", async () => {
  const { protocolPackageFiles } = await import(
    "../.agents/kernel/protocol-manifest.mjs"
  );
  const { SYNTAX_CHECK_FILES } = await import("../scripts/agentic-check.mjs");
  const expected = protocolPackageFiles().filter((path) => path.endsWith(".mjs"));
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const contract = await readFile(join(ROOT, "AGENTS.md"), "utf8");
  const readme = await readFile(join(ROOT, "README.md"), "utf8");

  assert.deepEqual(SYNTAX_CHECK_FILES, expected);
  assert.equal(manifest.scripts.check, "node scripts/agentic-check.mjs");
  assert.match(contract, /Focalizada: ejecutar `npm run check`/);
  assert.match(readme, /Validación sintáctica autoritativa:\s*```bash\s*npm run check/);

  const checked = spawnSync(process.execPath, [join(ROOT, "scripts", "agentic-check.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
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
    const phases = [...source.matchAll(/<!-- agentic-phase (\{[^\n]+\}) -->/g)].map(
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
  assert.ok(devSession.includes("Estrategia light:"));
  assert.ok(subdevSession.includes("- Unidad: `<work-unit-id>`"));
  assert.ok(subdevSession.includes("- Permiso: `<permission>`"));
  assert.ok(codexAdapter.includes(".agents/roles/implementador.md"));
  assert.ok(claudeAdapter.includes(".agents/roles/implementador.md"));
  assert.doesNotMatch(codexAdapter + claudeAdapter, /light\s*=\s*4|full\s*=\s*9/);
});

test("los contratos proyectan el contexto mínimo mediante un único sobre", async () => {
  const [orchestration, skill, subdevSession, ...roleSources] = await Promise.all([
    readFile(join(ROOT, ".agents", "policies", "orquestacion.md"), "utf8"),
    readFile(join(ROOT, ".agents", "skills", "orquestar", "SKILL.md"), "utf8"),
    readFile(join(ROOT, ".agents", "templates", "subdev-session.md"), "utf8"),
    ...["documentador", "evaluador", "explorador", "implementador", "planificador", "tester"].map(
      (role) => readFile(join(ROOT, ".agents", "roles", `${role}.md`), "utf8"),
    ),
  ]);
  const projection = markdownSection(orchestration, "Proyección mínima de contexto") ?? "";

  assert.notEqual(projection, "");
  assert.ok(projection.includes("`contextPaths`"));
  for (const role of [
    "Explorador",
    "Planificador",
    "Implementador",
    "Tester",
    "Evaluador",
    "Documentador",
  ]) {
    assert.ok(projection.includes(`**${role}:**`), `Falta la selección mínima de ${role}.`);
  }
  assert.ok(skill.includes("`contextPaths`"));
  assert.match(skill, /`WorkEnvelope` inmutable/);

  for (const source of roleSources) {
    const inputs = markdownSection(source, "Entradas") ?? "";
    assert.ok(inputs.includes("`WorkEnvelope` vigente"));
    assert.ok(inputs.includes("`contextPaths`"));
    assert.equal(inputs.includes("- DevSession vigente."), false);
    assert.equal(inputs.includes("Especificación y DevSession"), false);
    assert.equal(inputs.includes("Especificación, decisiones y DevSession"), false);
  }

  for (const heading of [
    "Objetivo específico",
    "Reglas efectivas aplicables",
    "Tareas y criterios asignados",
    "Hallazgos o revisiones pendientes de intentos anteriores",
    "Rutas de contexto seleccionadas",
  ]) {
    assert.notEqual(markdownSection(subdevSession, heading), null, `Falta ${heading}.`);
  }
  assert.ok(subdevSession.includes("- Revisión fuente: `<source-revision>`"));
  assert.doesNotMatch(subdevSession, /Según la DevSession global|DevSession global:/);

  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "contrato-contexto-minimo",
      description: "Valida la distribución del sobre mínimo por rol.",
    }),
  });
  const adoption = runInitializer(repository);
  assert.equal(adoption.status, SIN_HERRAMIENTAS, adoption.stderr || adoption.stdout);
});

test("la distribución conserva el contrato completo de intentos en protocolo y prosa", async () => {
  const read = (relativePath) =>
    readFile(join(ROOT, ...relativePath.split("/")), "utf8");
  const roleNames = [
    "documentador",
    "evaluador",
    "explorador",
    "implementador",
    "planificador",
    "tester",
  ];
  const workflowNames = ["architecture", "bugfix", "feature", "refactor"];
  const [
    envelopeSource,
    roleReportSource,
    policy,
    skill,
    devSession,
    subdevSession,
    readme,
    internalReadme,
    context,
    architecture,
    ...roleAndWorkflowSources
  ] = await Promise.all([
    read(".agents/schemas/work-envelope.schema.json"),
    read(".agents/schemas/role-report.schema.json"),
    read(".agents/policies/orquestacion.md"),
    read(".agents/skills/orquestar/SKILL.md"),
    read(".agents/templates/dev-session.md"),
    read(".agents/templates/subdev-session.md"),
    read("README.md"),
    read(".agents/README.md"),
    read("CONTEXT.md"),
    read("docs/arquitectura.md"),
    ...roleNames.map((role) => read(`.agents/roles/${role}.md`)),
    ...workflowNames.map((workflow) => read(`.agents/workflows/${workflow}.md`)),
  ]);
  const envelope = JSON.parse(envelopeSource);
  const roleReport = JSON.parse(roleReportSource);

  assert.equal(envelope.additionalProperties, false);
  assert.deepEqual(envelope.required, [
    "schemaVersion",
    "sessionId",
    "attemptId",
    "acceptanceContractHash",
    "contractKind",
    "generation",
    "sourceRevision",
    "baseRevision",
    "threadId",
    "phase",
    "role",
    "permission",
    "criteria",
    "ownedPaths",
    "validationStrategy",
    "wave",
    "objective",
    "rules",
    "tasks",
    "findings",
    "contextManifest",
    "contextPaths",
  ]);
  assert.equal(envelope.properties.schemaVersion.const, 3);
  assert.deepEqual(envelope.properties.permission.enum, ["read-only", "writer"]);
  assert.equal(Object.hasOwn(envelope.properties, "actorCapability"), false);
  assert.equal(Object.hasOwn(envelope.properties, "ledger"), false);
  assert.equal(roleReport.properties.schemaVersion.const, 3);
  assert.ok(
    roleReport.properties.findings.items.allOf.some((rule) =>
      rule.then?.required?.includes("reproduction"),
    ),
  );

  for (const field of [
    "`baseRevision`",
    "`threadId`",
    "`permission`",
    "`contextManifest`",
    "`ownedPaths`",
    "`validationStrategy`",
    "`sourceRevision`",
    "`contextPaths`",
  ]) {
    assert.ok(policy.includes(field), `La política omite ${field}.`);
    assert.ok(skill.includes(field), `La skill omite ${field}.`);
  }
  assert.match(policy, /Explorador, Planificador y Evaluador exigen\s+`read-only`/);
  assert.match(policy, /Implementador y\s+Documentador exigen `writer`/);
  assert.match(policy, /finding no informativo exige `reproduction`/);

  for (const field of [
    "`criterionIds`",
    "`dependsOn`",
    "`ownedPaths`",
    "`validationStrategy`",
    "`contextManifest`",
    "`contextPaths`",
  ]) {
    assert.ok(devSession.includes(field), `La DevSession omite ${field}.`);
  }
  for (const placeholder of [
    "<base-revision>",
    "<thread-id>",
    "<permission>",
    "<criteria>",
    "<owned-paths>",
    "<validation-strategy-or-null>",
    "<wave>",
  ]) {
    assert.ok(subdevSession.includes(placeholder), `La SubDevSession omite ${placeholder}.`);
  }
  assert.ok(subdevSession.includes("`contextManifest`"));
  assert.ok(subdevSession.includes("`contextPaths`"));

  const roleSources = roleAndWorkflowSources.slice(0, roleNames.length);
  const expectedPermissions = {
    documentador: ["`writer`"],
    evaluador: ["`read-only`"],
    explorador: ["`read-only`"],
    implementador: ["`writer`"],
    planificador: ["`read-only`"],
    tester: ["`read-only`", "`writer`"],
  };
  for (let index = 0; index < roleNames.length; index += 1) {
    const source = roleSources[index];
    assert.ok(source.includes("`WorkEnvelope` vigente"));
    for (const permission of expectedPermissions[roleNames[index]]) {
      assert.ok(source.includes(permission), `${roleNames[index]} omite ${permission}.`);
    }
  }

  for (const source of roleAndWorkflowSources.slice(roleNames.length)) {
    assert.ok(source.includes("`WorkEnvelope` completo"));
    assert.ok(source.includes("`read-only`"));
    assert.ok(source.includes("`writer`"));
  }
  for (const source of [readme, internalReadme, context, architecture]) {
    assert.ok(source.includes("`contextManifest`"));
    assert.ok(source.includes("`contextPaths`"));
    assert.ok(source.includes("`RoleReport`"));
    assert.ok(source.includes("schemaVersion"));
  }
});

test("la documentación distingue ledger y sobre de contexto mínimo", async () => {
  const [readme, internalReadme, context, architecture] = await Promise.all([
    readFile(join(ROOT, "README.md"), "utf8"),
    readFile(join(ROOT, ".agents", "README.md"), "utf8"),
    readFile(join(ROOT, "CONTEXT.md"), "utf8"),
    readFile(join(ROOT, "docs", "arquitectura.md"), "utf8"),
  ]);

  for (const source of [readme, internalReadme, architecture]) {
    assert.ok(source.includes("`contextPaths`"));
    assert.ok(source.includes("`sourceRevision`"));
  }
  assert.ok(context.includes("**Ledger de coordinación**:"));
  assert.ok(context.includes("**Sobre de despacho**:"));
  assert.notEqual(
    markdownSection(architecture, "Proyección de contexto y traspaso de reportes"),
    null,
  );
  assert.match(readme + internalReadme + architecture, /incógnita exacta/);
});

test("los workflows declaran una única secuencia estructural para light compacto", async () => {
  for (const workflow of ["architecture", "bugfix", "feature", "refactor"]) {
    const source = await readFile(
      join(ROOT, ".agents", "workflows", `${workflow}.md`),
      "utf8",
    );
    const phases = new Map(
      [...source.matchAll(/<!-- agentic-phase (\{[^\n]+\}) -->/g)].map((match) => {
        const phase = JSON.parse(match[1]);
        return [phase.id, phase.role];
      }),
    );
    const markers = [...source.matchAll(/<!-- agentic-light-sequence (\{[^\n]+\}) -->/g)];
    if (workflow === "architecture") {
      assert.equal(markers.length, 0);
      continue;
    }
    assert.equal(markers.length, 1, `${workflow} debe declarar una sola secuencia compacta.`);
    const contract = JSON.parse(markers[0][1]);
    assert.deepEqual(Object.keys(contract), ["phases"]);
    assert.ok(Array.isArray(contract.phases));
    assert.equal(new Set(contract.phases).size, contract.phases.length);
    assert.equal(contract.phases.every((phaseId) => phases.has(phaseId)), true);
    const roles = contract.phases.map((phaseId) => phases.get(phaseId));
    assert.equal(roles.at(-1), "evaluador");
    assert.equal(roles.filter((role) => role === "implementador").length, 1);
    assert.equal(roles.includes("explorador"), false);
    if (workflow === "bugfix") {
      assert.equal(roles[0], "tester");
      assert.equal(contract.phases[0], "bugfix-reproduce");
    } else {
      assert.equal(roles[0], "planificador");
      assert.equal(roles.includes("tester"), false);
    }
  }
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
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.match(
    activationSeam + decisionSeam,
    /excepción bootstrap[\s\S]*un solo agente[\s\S]*sin DevSession/i,
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
    const phases = [...workflow.matchAll(/<!-- agentic-phase (\{[^\n]+\}) -->/g)].map(
      (match) => JSON.parse(match[1]),
    );
    assert.deepEqual(phases.at(-1), { id: `${name}-document`, role: "documentador" });
    assert.equal(linksToPolicy(workflow, "orquestacion.md"), true);
  }
});

test("el contrato estructurado único se distribuye con ownership único y preserva sesiones", async () => {
  const compositionPath = ".agents/kernel/composition.mjs";
  const kernelPath = ".agents/kernel/orchestration-kernel.mjs";
  const protocolModulePath = ".agents/kernel/protocol.mjs";
  const protocolManifestPath = ".agents/protocol.json";
  const subdevTemplatePath = ".agents/templates/subdev-session.md";
  const schemaPaths = [
    ".agents/schemas/acceptance-contract.schema.json",
    ".agents/schemas/role-report.schema.json",
    ".agents/schemas/session-event.schema.json",
    ".agents/schemas/validation-evidence.schema.json",
  ];
  const currentPaths = [
    ".agents/conformance/protocol-conformance.mjs",
    ".agents/kernel/adapters.mjs",
    compositionPath,
    kernelPath,
    protocolModulePath,
    protocolManifestPath,
    ...schemaPaths,
    subdevTemplatePath,
  ];
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const orchestration = await readFile(
    join(ROOT, ".agents", "policies", "orquestacion.md"),
    "utf8",
  );
  const skill = await readFile(join(ROOT, ".agents", "skills", "orquestar", "SKILL.md"), "utf8");
  const codex = await readFile(join(ROOT, ".codex", "agents", "implementador.toml"), "utf8");
  const claude = await readFile(join(ROOT, ".claude", "agents", "implementador.md"), "utf8");
  const claudeImport = await readFile(join(ROOT, "CLAUDE.md"), "utf8");
  const claudeSkill = await readFile(
    join(ROOT, ".claude", "skills", "orquestar", "SKILL.md"),
    "utf8",
  );
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name: "adopcion-contrato",
      description: "Comprueba la distribución del contrato estructurado.",
    }),
  });
  const codexHome = await createRepository();
  const adoption = runInitializer(repository);
  const activeSession = join(repository, ".agents", "sessions", "validacion-activa.md");
  await mkdir(dirname(activeSession), { recursive: true });
  await writeFile(activeSession, "# DevSession: validacion-activa\n", "utf8");
  try {
    const validation = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--yes",
      "--codex-config",
      "none",
    );

    assert.deepEqual(
      {
        adaptersPortable:
          codex.includes("RoleReport") &&
          claude.includes("RoleReport") &&
          codex.includes("No uses OrchestrationKernel.apply") &&
          claude.includes("No uses") &&
          claude.includes("OrchestrationKernel.apply"),
        adopted: currentPaths.every((path) =>
          existsSync(join(repository, ...path.split("/"))),
        ),
        adoptionStatus: adoption.status,
        inventories: {
          manifest: currentPaths.every((path) => manifest.files.includes(path)),
          package: currentPaths.every((path) => PACKAGE_FILES.includes(path)),
          template: currentPaths.every((path) => TEMPLATE_FILES.includes(path)),
        },
        orchestrationContract:
          orchestration.includes("OrchestrationKernel") &&
          orchestration.includes("createOrchestrationComposition") &&
          orchestration.includes("agentic-bootstrap-repair") &&
          orchestration.includes("Contexto de una tarea anterior") &&
          markdownLinks(skill).some((target) =>
            target.split("#")[0].endsWith("/kernel/composition.mjs"),
          ),
        claudeEntrypoints:
          [claudeImport, claudeSkill].every(
            (entrypoint) =>
              entrypoint.includes("agentic-protocol") &&
              entrypoint.includes(".agents/kernel/composition.mjs") &&
              entrypoint.includes(".agents/kernel/orchestration-kernel.mjs"),
          ) &&
          claudeSkill.includes("WorkEnvelope") &&
          claudeSkill.includes("RoleReport"),
        packageExcludesSessions: manifest.files.every(
          (path) => !path.startsWith(".agents/sessions/") || path === ".agents/sessions/gitignore.asset",
        ),
        validation: { code: validation.status, stderr: validation.stderr },
        sessionPreserved: existsSync(activeSession),
      },
      {
        adaptersPortable: true,
        adopted: true,
        adoptionStatus: SIN_HERRAMIENTAS,
        inventories: { manifest: true, package: true, template: true },
        orchestrationContract: true,
        claudeEntrypoints: true,
        packageExcludesSessions: true,
        validation: { code: SIN_HERRAMIENTAS, stderr: "" },
        sessionPreserved: true,
      },
    );
  } finally {
    await rm(activeSession, { force: true });
  }
});
