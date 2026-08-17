import assert from "node:assert/strict";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { OrchestrationKernel } from "../.agents/kernel/orchestration-kernel.mjs";
import { assertProtocolConformance } from "../.agents/conformance/protocol-conformance.mjs";
import {
  FakeClock,
  FakeEnvironmentProbe,
  FileSystemStateStore,
  JsonlEventSink,
  MemoryEventSink,
  MemoryStateStore,
  createBootstrapCapability,
} from "../.agents/kernel/adapters.mjs";
import {
  digestObject,
  withAcceptanceContractHash,
} from "../.agents/kernel/protocol.mjs";

let sequence = 0;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function commandId(label = "command") {
  sequence += 1;
  return `${label}-${sequence}`;
}

function acceptanceContract(overrides = {}) {
  const base = {
    schemaVersion: 2,
    contractId: "AC-01",
    version: 1,
    userIntent: "Implementar una unidad verificable.",
    nonGoals: ["No ampliar el producto."],
    riskClass: "medium",
    criteria: [
      { id: "AC-01-C01", statement: "La unidad queda validada.", oracle: "Reporte estructurado." },
    ],
    transversalPolicies: [{ id: "POL-01", version: "1" }],
    threatModel: {
      commitPoints: [],
      enumeratedFaults: [],
      excludedFaults: [],
    },
    approval: { kind: "explicit-user-or-policy", reference: "fixture" },
    ...overrides,
  };
  return withAcceptanceContractHash(base);
}

function unit(overrides = {}) {
  return {
    workUnitId: "unit-1",
    criterionIds: ["AC-01-C01"],
    dependsOn: [],
    ownedPaths: ["src/unit.mjs"],
    ...overrides,
  };
}

function finding(classification, overrides = {}) {
  const blocking = classification === "acceptance_violation";
  const policy = classification === "transversal_policy_violation";
  const actionable = classification !== "informational";
  return {
    findingId: `F-${sequence + 1}`,
    classification,
    severity: "high",
    criterionIds: blocking ? ["AC-01-C01"] : [],
    policyIds: policy ? ["POL-01"] : [],
    summary: "Hallazgo reproducible.",
    ...(actionable
      ? { reproduction: { commandDigest: digestObject("command"), expected: "verde", observed: "rojo" } }
      : {}),
    ...overrides,
  };
}

function roleReport(harness, attempt, role, overrides = {}) {
  return {
    schemaVersion: 2,
    sessionId: harness.sessionId,
    attemptId: attempt,
    acceptanceContractHash: harness.contract.hash,
    role,
    completion: "completed",
    decision: "pass",
    findings: [],
    evidence: [{ kind: "command", commandDigest: digestObject(attempt), exitCode: 0, durationMs: 1 }],
    humanSummary: "Completado.",
    ...overrides,
  };
}

function validationEvidence(generation, overrides = {}) {
  return {
    schemaVersion: 2,
    laneId: `full:${generation}`,
    generation,
    treeFingerprint: digestObject(`tree-${generation}`),
    environmentFingerprint: digestObject("environment"),
    commands: [{ digest: digestObject("node-test"), exitCode: 0, durationMs: 25 }],
    decision: "pass",
    ...overrides,
  };
}

function createHarness({
  clock = new FakeClock(),
  configuration,
  environmentProbe = new FakeEnvironmentProbe(),
  eventSink = new MemoryEventSink(),
  sessionId = `session-${commandId("fixture")}`,
  stateStore = new MemoryStateStore(),
} = {}) {
  const bootstrapCapability = createBootstrapCapability();
  const kernel = new OrchestrationKernel({
    bootstrapCapability,
    clock,
    configuration,
    environmentProbe,
    eventSink,
    stateStore,
  });
  return {
    bootstrapCapability,
    capability: undefined,
    clock,
    contract: acceptanceContract(),
    environmentProbe,
    eventSink,
    kernel,
    sessionId,
    stateStore,
  };
}

async function apply(harness, type, payload = {}, options = {}) {
  const view = await harness.kernel.inspect(harness.sessionId).catch(() => ({ revision: 0 }));
  return harness.kernel.apply({
    schemaVersion: 2,
    commandId: options.commandId ?? commandId(type),
    sessionId: harness.sessionId,
    expectedRevision: options.expectedRevision ?? view.revision,
    actorCapability: options.actorCapability ?? harness.capability,
    type,
    payload,
  });
}

async function start(harness, overrides = {}, options = {}) {
  const { lightStrategy, mode = "light", ...startOverrides } = overrides;
  const result = await harness.kernel.apply({
    schemaVersion: 2,
    commandId: options.commandId ?? commandId("start"),
    sessionId: harness.sessionId,
    expectedRevision: 0,
    actorCapability: harness.bootstrapCapability,
    type: "start-session",
    payload: {
      mode,
      ...(mode === "light" ? { lightStrategy: lightStrategy ?? "compact" } : {}),
      workflow: "feature",
      ...startOverrides,
    },
  });
  harness.capability = result.actorCapability;
  return result;
}

async function plan(harness, overrides = {}) {
  const { contract, ...planOverrides } = overrides;
  harness.contract = contract ?? harness.contract;
  return apply(harness, "accept-plan", {
    acceptanceContract: harness.contract,
    documentationRequired: false,
    documentationReason: "No cambia documentación.",
    workUnits: [unit()],
    ...planOverrides,
  });
}

async function dispatchAndReport(harness, { role, attempt = commandId(role), report = {}, ...payload }) {
  const dispatched = await apply(harness, "dispatch-attempt", {
    attemptId: attempt,
    contextManifest: [],
    findings: [],
    objective: `Ejecutar ${role}.`,
    role,
    rules: "Aplicar el contrato.",
    tasks: "Completar el intento.",
    ...payload,
  });
  const accepted = await apply(harness, "accept-role-report", {
    attemptId: attempt,
    report: roleReport(harness, attempt, role, report),
  });
  return { accepted, attempt, dispatched };
}

async function dispatchWriter(harness, attemptId, options = {}) {
  return apply(
    harness,
    "dispatch-attempt",
    {
      attemptId,
      contextManifest: [],
      findings: [],
      objective: "Implementar la unidad writer.",
      role: "implementador",
      rules: "Aplicar el contrato.",
      tasks: "Completar la unidad.",
      workUnitId: "unit-1",
    },
    options,
  );
}

async function readWriterReservation(root) {
  const directory = join(root, ".agents", "sessions", "state");
  const names = await readdir(directory);
  const locks = names.filter((name) => /^\.writer-[a-f0-9]{64}\.lock$/.test(name));
  assert.equal(locks.length, 1, "Debe existir una única reserva durable del writer.");
  const path = join(directory, locks[0]);
  return { path, reservation: JSON.parse(await readFile(path, "utf8")) };
}

async function reachEvaluation(harness, { mode = "light", strategy = "combined", risk } = {}) {
  await start(harness, {
    mode,
    ...(mode === "light" ? { lightStrategy: "compact" } : {}),
    evaluationStrategy: strategy,
    evaluationRisk: risk,
  });
  await plan(harness, { evaluationStrategy: strategy, evaluationRisk: risk });
  await dispatchAndReport(harness, { role: "implementador", workUnitId: "unit-1" });
  if (mode !== "light") {
    await dispatchAndReport(harness, { role: "tester", workUnitId: "unit-1" });
  }
  if (mode === "full") {
    const view = await harness.kernel.inspect(harness.sessionId);
    await apply(harness, "record-validation", { evidence: validationEvidence(view.generation) });
  }
  assert.equal((await harness.kernel.inspect(harness.sessionId)).lifecycle, "evaluating");
}

async function evaluate(harness, reports, strategy = "combined") {
  const axes = strategy === "dual" ? ["standards", "specification"] : ["combined"];
  const attempts = [];
  for (const axis of axes) {
    const attempt = commandId(`evaluate-${axis}`);
    await apply(harness, "dispatch-attempt", {
      attemptId: attempt,
      contextManifest: [],
      evaluationAxis: axis,
      findings: [],
      objective: `Evaluar ${axis}.`,
      role: "evaluador",
      rules: "Aplicar aceptación congelada.",
      tasks: "Emitir RoleReport.",
    });
    attempts.push({ attempt, axis });
  }
  const results = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const { attempt, axis } = attempts[index];
    results.push(
      await apply(harness, "accept-role-report", {
        attemptId: attempt,
        report: roleReport(harness, attempt, "evaluador", reports[index] ?? reports[0] ?? {}),
      }),
    );
    assert.equal(axis, axes[index]);
  }
  return results;
}

async function rebuildAfterEvaluation(harness, mode) {
  await dispatchAndReport(harness, { role: "implementador", workUnitId: "unit-1" });
  if (mode !== "light") {
    await dispatchAndReport(harness, { role: "tester", workUnitId: "unit-1" });
  }
  if (mode === "full") {
    const view = await harness.kernel.inspect(harness.sessionId);
    await apply(harness, "record-validation", { evidence: validationEvidence(view.generation) });
  }
}

test("el kernel expone únicamente apply e inspect y la prosa no decide el estado", async () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(OrchestrationKernel.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
    ["apply", "inspect"],
  );
  assert.throws(
    () => new OrchestrationKernel({ bootstrapCapability: createBootstrapCapability() }),
    /stateStore es obligatorio/,
  );

  for (const humanSummary of ["Ninguno", "Ninguno reproducible", "No aplica"]) {
    const harness = createHarness();
    await start(harness, { mode: "full" });
    await plan(harness);
    await dispatchAndReport(harness, { role: "implementador", workUnitId: "unit-1" });
    await dispatchAndReport(harness, {
      role: "tester",
      workUnitId: "unit-1",
      report: { humanSummary },
    });
    const view = await harness.kernel.inspect(harness.sessionId);
    assert.equal(view.workUnits["unit-1"].validated, true);
  }
});

test("rechaza reportes contradictorios sin mutar y persiste un fallo estructurado", async () => {
  const harness = createHarness();
  await start(harness, { mode: "full" });
  await plan(harness);
  await dispatchAndReport(harness, { role: "implementador", workUnitId: "unit-1" });
  const attempt = commandId("tester");
  await apply(harness, "dispatch-attempt", {
    attemptId: attempt,
    contextManifest: [],
    findings: [],
    objective: "Validar.",
    role: "tester",
    rules: "Contrato.",
    tasks: "Probar.",
    workUnitId: "unit-1",
  });
  const revision = (await harness.kernel.inspect(harness.sessionId)).revision;
  await assert.rejects(
    apply(
      harness,
      "accept-role-report",
      {
        attemptId: attempt,
        report: roleReport(harness, attempt, "tester", {
          decision: "pass",
          findings: [finding("acceptance_violation")],
        }),
      },
      { expectedRevision: revision },
    ),
    { code: "invalid_role_report" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, revision);
  await apply(harness, "accept-role-report", {
    attemptId: attempt,
    report: roleReport(harness, attempt, "tester", {
      decision: "fail",
      findings: [finding("acceptance_violation")],
      humanSummary: "Fallo reproducido.",
    }),
  });
  const view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.workUnits["unit-1"].status, "needs_rework");
  assert.equal(Object.keys(view.findings).length, 1);
});

test("completion needs_input pausa sin convertir la consulta en fallo y reanuda la fase", async () => {
  const harness = createHarness();
  await start(harness, { mode: "full" });
  await plan(harness);
  const attempt = commandId("needs-input");
  await apply(harness, "dispatch-attempt", {
    attemptId: attempt,
    contextManifest: [],
    findings: [],
    objective: "Implementar.",
    role: "implementador",
    rules: "Contrato.",
    tasks: "Unidad.",
    workUnitId: "unit-1",
  });
  const paused = await apply(harness, "accept-role-report", {
    attemptId: attempt,
    report: roleReport(harness, attempt, "implementador", {
      completion: "needs_input",
      decision: "pass",
      humanSummary: "Falta una decisión del usuario.",
    }),
  });
  assert.equal(paused.decision, "needs_input");
  let view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.lifecycle, "awaiting_input");
  assert.equal(view.workUnits["unit-1"].status, "pending");
  await apply(harness, "record-user-input", { reference: "respuesta-1" });
  view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.lifecycle, "executing");
  assert.equal(view.workUnits["unit-1"].status, "pending");
});

test("la capacidad única protege ownership, idempotencia y CAS sin filtrarse al sobre", async () => {
  const harness = createHarness();
  const startId = commandId("start-idempotent");
  const startCommand = {
    schemaVersion: 2,
    commandId: startId,
    sessionId: harness.sessionId,
    expectedRevision: 0,
    actorCapability: harness.bootstrapCapability,
    type: "start-session",
    payload: { mode: "light", lightStrategy: "compact", workflow: "feature" },
  };
  const first = await harness.kernel.apply(startCommand);
  harness.capability = first.actorCapability;
  const retry = await harness.kernel.apply(startCommand);
  assert.equal(retry.revision, first.revision);
  assert.equal(retry.actorCapability, first.actorCapability);
  assert.equal(harness.eventSink.events.length, 1);

  await assert.rejects(
    harness.kernel.apply({ ...startCommand, payload: { ...startCommand.payload, workflow: "refactor" } }),
    { code: "idempotency_conflict" },
  );
  await assert.rejects(
    harness.kernel.apply({
      schemaVersion: 2,
      commandId: commandId("role-mutation"),
      sessionId: harness.sessionId,
      expectedRevision: 1,
      actorCapability: Object.freeze({ role: "tester" }),
      type: "accept-plan",
      payload: {},
    }),
    { code: "actor_not_authorized" },
  );
  await plan(harness);
  const revision = (await harness.kernel.inspect(harness.sessionId)).revision;
  await assert.rejects(
    apply(harness, "record-user-input", { reference: "stale" }, { expectedRevision: revision - 1 }),
    { code: "stale_revision" },
  );
  const attempt = commandId("envelope");
  const dispatched = await apply(harness, "dispatch-attempt", {
    attemptId: attempt,
    contextManifest: [],
    findings: [],
    objective: "Implementar.",
    role: "implementador",
    rules: "Contrato.",
    tasks: "Unidad.",
    workUnitId: "unit-1",
  });
  assert.equal("actorCapability" in dispatched.envelope, false);
  assert.doesNotMatch(JSON.stringify(dispatched.envelope), /capability|secret|token/i);
  assert.deepEqual(dispatched.envelope.contextPaths, []);
  assert.equal(Object.isFrozen(dispatched.envelope.contextPaths), true);
});

test("un host reiniciado recupera capacidad solo mediante el retry exacto de start-session", async () => {
  const stateStore = new MemoryStateStore();
  const clock = new FakeClock();
  const original = createHarness({
    clock,
    configuration: { capabilityTtlMs: 5 },
    sessionId: "recover-capability",
    stateStore,
  });
  const startId = commandId("recoverable-start");
  const payload = { mode: "light", lightStrategy: "compact", workflow: "feature" };
  const first = await original.kernel.apply({
    schemaVersion: 2,
    commandId: startId,
    sessionId: original.sessionId,
    expectedRevision: 0,
    actorCapability: original.bootstrapCapability,
    type: "start-session",
    payload,
  });
  clock.advance(6);
  await assert.rejects(
    original.kernel.apply({
      schemaVersion: 2,
      commandId: commandId("expired"),
      sessionId: original.sessionId,
      expectedRevision: 1,
      actorCapability: first.actorCapability,
      type: "accept-plan",
      payload: {},
    }),
    { code: "actor_not_authorized" },
  );

  const recoveredBootstrap = createBootstrapCapability();
  const recoveredKernel = new OrchestrationKernel({
    bootstrapCapability: recoveredBootstrap,
    clock,
    configuration: { capabilityTtlMs: 5 },
    environmentProbe: new FakeEnvironmentProbe(),
    stateStore,
  });
  const recoveryView = await recoveredKernel.inspect(original.sessionId);
  assert.equal("actorCapability" in recoveryView.recovery.bootstrapCommand, false);
  const recovered = await recoveredKernel.apply({
    ...recoveryView.recovery.bootstrapCommand,
    actorCapability: recoveredBootstrap,
  });
  assert.ok(recovered.actorCapability);
  assert.notEqual(recovered.actorCapability, first.actorCapability);
  assert.equal(recovered.revision, 1);
  await assert.rejects(
    recoveredKernel.apply({
      schemaVersion: 2,
      commandId: startId,
      sessionId: original.sessionId,
      expectedRevision: 0,
      actorCapability: recoveredBootstrap,
      type: "start-session",
      payload: { ...payload, workflow: "refactor" },
    }),
    { code: "idempotency_conflict" },
  );
});

test("clasifica violaciones vigentes, findings nuevos y referencias inválidas", async () => {
  for (const classification of ["acceptance_violation", "transversal_policy_violation"]) {
    const harness = createHarness();
    await reachEvaluation(harness);
    const [result] = await evaluate(harness, [
      { decision: "fail", findings: [finding(classification)] },
    ]);
    assert.equal(result.decision, "changes_required");
    assert.equal((await harness.kernel.inspect(harness.sessionId)).evaluationReworkCycles, 1);
  }

  const critical = createHarness();
  await reachEvaluation(critical);
  const [criticalResult] = await evaluate(critical, [
    {
      decision: "fail",
      findings: [finding("novel_adversarial_finding", { severity: "critical" })],
    },
  ]);
  assert.equal(criticalResult.state, "scope_decision_required");
  assert.equal(criticalResult.reason, "novel_adversarial_finding");
  assert.equal((await critical.kernel.inspect(critical.sessionId)).workUnits["unit-1"].status, "validated");

  const nonCritical = createHarness();
  await reachEvaluation(nonCritical);
  const [deferred] = await evaluate(nonCritical, [
    {
      decision: "fail",
      findings: [finding("novel_adversarial_finding", { severity: "medium" })],
    },
  ]);
  assert.equal(deferred.decision, "pass");
  assert.equal(deferred.state, "completed");
  const nonCriticalView = await nonCritical.kernel.inspect(nonCritical.sessionId);
  assert.equal(nonCriticalView.deferredFindings.length, 1);
  assert.equal(
    nonCriticalView.findings[nonCriticalView.deferredFindings[0]].status,
    "deferred",
  );

  const invalidReference = createHarness();
  await reachEvaluation(invalidReference);
  const attempt = commandId("invalid-reference");
  await apply(invalidReference, "dispatch-attempt", {
    attemptId: attempt,
    contextManifest: [],
    evaluationAxis: "combined",
    findings: [],
    objective: "Evaluar.",
    role: "evaluador",
    rules: "Contrato.",
    tasks: "Criterios.",
  });
  const before = await invalidReference.kernel.inspect(invalidReference.sessionId);
  await assert.rejects(
    apply(invalidReference, "accept-role-report", {
      attemptId: attempt,
      report: roleReport(invalidReference, attempt, "evaluador", {
        decision: "fail",
        findings: [finding("acceptance_violation", { criterionIds: ["AC-404"] })],
      }),
    }),
    { code: "invalid_role_report" },
  );
  assert.equal((await invalidReference.kernel.inspect(invalidReference.sessionId)).revision, before.revision);
});

test("congela aceptación, exige threat model destructivo y registra amendments explícitos", async () => {
  const harness = createHarness();
  await start(harness, { mode: "full" });
  const incomplete = acceptanceContract({ destructive: true });
  harness.contract = incomplete;
  const blocked = await plan(harness);
  assert.equal(blocked.decision, "needs_input");
  assert.deepEqual(blocked.missing.sort(), [
    "commitPoints",
    "postCommitFailureSemantics",
    "preCommitFailureSemantics",
  ]);
  assert.equal((await harness.kernel.inspect(harness.sessionId)).lifecycle, "awaiting_input");
  await apply(harness, "record-user-input", { reference: "respuesta-usuario" });
  harness.contract = acceptanceContract({
    destructive: true,
    threatModel: {
      commitPoints: ["rename-atómico"],
      preCommitFailureSemantics: "Retirar temporal.",
      postCommitFailureSemantics: "Conservar resultado y reportar cleanup pendiente.",
      enumeratedFaults: ["EPERM"],
      excludedFaults: ["fallo físico"],
    },
  });
  await plan(harness);
  await dispatchAndReport(harness, { role: "implementador", workUnitId: "unit-1" });
  const tester = commandId("contract-mismatch");
  await apply(harness, "dispatch-attempt", {
    attemptId: tester,
    contextManifest: [],
    findings: [],
    objective: "Validar.",
    role: "tester",
    rules: "Contrato.",
    tasks: "Probar.",
    workUnitId: "unit-1",
  });
  await assert.rejects(
    apply(harness, "accept-role-report", {
      attemptId: tester,
      report: { ...roleReport(harness, tester, "tester"), acceptanceContractHash: digestObject("otro") },
    }),
    { code: "acceptance_contract_mismatch" },
  );

  const scope = createHarness();
  await reachEvaluation(scope);
  await evaluate(scope, [
    {
      decision: "fail",
      findings: [finding("novel_adversarial_finding", { severity: "critical" })],
    },
  ]);
  const beforeInvalidAmendment = await scope.kernel.inspect(scope.sessionId);
  const rewritten = acceptanceContract({
    version: 2,
    criteria: [
      { id: "AC-01-C01", statement: "Criterio reescrito.", oracle: "Otro oráculo." },
    ],
  });
  await assert.rejects(
    apply(scope, "amend-scope", {
      acceptanceContract: rewritten,
      approvalReference: "usuario-no-autoriza-reescritura",
    }),
    { code: "invalid_scope_amendment" },
  );
  assert.equal(
    (await scope.kernel.inspect(scope.sessionId)).revision,
    beforeInvalidAmendment.revision,
  );
  const amended = acceptanceContract({
    version: 2,
    criteria: [
      ...scope.contract.criteria,
      { id: "AC-01-C02", statement: "Cubrir el finding nuevo.", oracle: "Caso adversarial verde." },
    ],
  });
  const result = await apply(scope, "amend-scope", {
    acceptanceContract: amended,
    approvalReference: "usuario-2026-08-17",
    additionalReworkCycles: 1,
  });
  assert.equal(result.decision, "amended");
  const view = await scope.kernel.inspect(scope.sessionId);
  assert.equal(view.acceptanceContract.version, 2);
  assert.equal(view.scopeAmendments.length, 1);
  assert.equal(view.scopeAmendments[0].findingFingerprints.length, 1);
  assert.equal(
    view.findings[view.scopeAmendments[0].findingFingerprints[0]].status,
    "incorporated",
  );
  assert.equal(view.maxEvaluationReworkCycles, 3);
  const amendedRevision = view.revision;
  await assert.rejects(plan(scope, { contract: acceptanceContract() }), {
    code: "acceptance_contract_mismatch",
  });
  assert.equal((await scope.kernel.inspect(scope.sessionId)).revision, amendedRevision);
});

test("aplica dos ciclos de retrabajo y bloquea el tercero por igual en full y light", async () => {
  for (const mode of ["full", "light"]) {
    const harness = createHarness();
    await reachEvaluation(harness, { mode });
    for (let rejection = 1; rejection <= 3; rejection += 1) {
      const [result] = await evaluate(harness, [
        { decision: "fail", findings: [finding("acceptance_violation")] },
      ]);
      if (rejection < 3) {
        assert.equal(result.decision, "changes_required");
        assert.equal(result.evaluationReworkCycle, rejection);
        await rebuildAfterEvaluation(harness, mode);
      } else {
        assert.equal(result.reason, "rework_budget_exhausted");
        assert.equal(result.state, "scope_decision_required");
      }
    }
    const view = await harness.kernel.inspect(harness.sessionId);
    assert.equal(view.evaluationReworkCycles, 2);
    assert.equal(view.lifecycle, "scope_decision_required");
  }
});

test("dual comparte generación, un ciclo y un finding semántico con dos fuentes", async () => {
  const harness = createHarness();
  await reachEvaluation(harness, {
    mode: "full",
    strategy: "dual",
    risk: "public-compatibility-or-migration",
  });
  const shared = finding("acceptance_violation", { findingId: "F-DUAL" });
  const results = await evaluate(
    harness,
    [
      { decision: "fail", findings: [shared] },
      {
        decision: "fail",
        findings: [
          { ...shared, findingId: "F-DUAL-OTHER", summary: "La misma evidencia, narrada distinto." },
        ],
      },
    ],
    "dual",
  );
  assert.equal(results[0].decision, "axis_recorded");
  assert.equal(results[1].decision, "changes_required");
  const view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.evaluationReworkCycles, 1);
  assert.equal(Object.keys(view.findings).length, 1);
  assert.equal(Object.values(view.findings)[0].sources.length, 2);
});

test("representa el lane full, reutiliza una evidencia por fingerprint e invalida cambios", async () => {
  const early = createHarness();
  await start(early, { mode: "full" });
  await plan(early);
  await assert.rejects(
    apply(early, "record-validation", { evidence: validationEvidence(1) }),
    { code: "fan_in_pending" },
  );

  const harness = createHarness();
  await start(harness, { mode: "full" });
  await plan(harness);
  await dispatchAndReport(harness, { role: "implementador", workUnitId: "unit-1" });
  await dispatchAndReport(harness, { role: "tester", workUnitId: "unit-1" });
  const laneAttempt = commandId("full-lane");
  await dispatchAndReport(harness, {
    attempt: laneAttempt,
    role: "tester",
    laneId: "full:1",
    report: { humanSummary: "Suite full verde." },
  });
  const evidence = validationEvidence(1);
  const revisionBeforeContradiction = (await harness.kernel.inspect(harness.sessionId)).revision;
  await assert.rejects(
    apply(harness, "record-validation", {
      evidence: validationEvidence(1, {
        commands: [{ digest: digestObject("node-test-red"), exitCode: 1, durationMs: 25 }],
        decision: "pass",
      }),
    }),
    { code: "invalid_validation_evidence" },
  );
  assert.equal(
    (await harness.kernel.inspect(harness.sessionId)).revision,
    revisionBeforeContradiction,
  );
  const first = await apply(harness, "record-validation", { evidence });
  const events = harness.eventSink.events.length;
  const reused = await apply(harness, "record-validation", { evidence });
  assert.equal(first.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(reused.revision, first.revision);
  assert.equal(harness.eventSink.events.length, events);
  await assert.rejects(
    apply(harness, "record-validation", {
      evidence: validationEvidence(1, { treeFingerprint: digestObject("changed-tree") }),
    }),
    { code: "fan_in_pending" },
  );
});

test("el preflight falla antes del snapshot y limpia sus probes", async () => {
  for (const failure of [
    { check: "store", code: "EPERM", operation: "write", path: "fixture://sessions" },
    { check: "lock", code: "EEXIST", operation: "lock", path: "fixture://lock" },
    { check: "cache", code: "SQLITE_CANTOPEN", operation: "open-cache", path: "fixture://cache" },
    { check: "cleanup", code: "EPERM", operation: "cleanup-probe", path: "fixture://probe" },
  ]) {
    const environmentProbe = new FakeEnvironmentProbe({ failure });
    const harness = createHarness({ environmentProbe });
    await assert.rejects(start(harness), (error) => {
      assert.equal(error.code, "environment_failed");
      assert.equal(error.details.path, failure.path);
      assert.ok(error.details.remedy);
      return true;
    });
    assert.equal(await harness.stateStore.load(harness.sessionId), undefined);
    assert.deepEqual(environmentProbe.residuals, []);
  }
});

test("el kernel usa el EnvironmentProbe real por defecto", async () => {
  const stateStore = new MemoryStateStore({
    probeFailure: {
      code: "EPERM",
      message: "Store de producción no escribible.",
      operation: "write",
      path: "memory://production-store",
      remedy: "Usar un store escribible.",
    },
  });
  const bootstrapCapability = createBootstrapCapability();
  const kernel = new OrchestrationKernel({
    bootstrapCapability,
    clock: new FakeClock(),
    stateStore,
  });
  await assert.rejects(
    kernel.apply({
      schemaVersion: 2,
      commandId: commandId("default-environment-probe"),
      sessionId: "default-environment-probe",
      expectedRevision: 0,
      actorCapability: bootstrapCapability,
      type: "start-session",
      payload: { mode: "full", workflow: "feature" },
    }),
    (error) => {
      assert.equal(error.code, "environment_failed");
      assert.equal(error.details.path, "memory://production-store");
      return true;
    },
  );
  assert.equal(await stateStore.load("default-environment-probe"), undefined);
});

test("telemetría atribuye actor, tiempos, contexto y degradación sin secretos", async () => {
  const secret = "capability-super-secret";
  const clock = new FakeClock();
  const eventSink = new MemoryEventSink({ knownSecrets: [secret] });
  const harness = createHarness({ clock, eventSink });
  await start(harness);
  clock.advance(10);
  await plan(harness);
  clock.advance(15, { wallMilliseconds: -1_000 });
  const attempt = commandId("context");
  await apply(harness, "dispatch-attempt", {
    attemptId: attempt,
    contextManifest: [
      { path: "src/a.mjs", hash: digestObject("a"), bytes: 10 },
      { path: "SRC/A.mjs", hash: digestObject("a"), bytes: 10 },
    ],
    elevation: { required: true, approved: true, durationMs: 4 },
    findings: [],
    objective: "Implementar.",
    retryCause: "timeout",
    role: "implementador",
    rules: "Contrato.",
    tasks: "Unidad.",
    workUnitId: "unit-1",
  });
  assert.equal(eventSink.events.every((event) => event.actor === "orchestrator"), true);
  const dispatchEvent = eventSink.events.at(-1);
  assert.equal(dispatchEvent.contextBytes, 10);
  assert.deepEqual(dispatchEvent.contextPaths, ["src/a.mjs"]);
  assert.deepEqual(dispatchEvent.elevation, { approved: true, durationMs: 4, required: true });
  assert.equal(dispatchEvent.retryCause, "timeout");
  assert.equal(dispatchEvent.stateDurationMs, 15);
  assert.doesNotMatch(JSON.stringify(eventSink.events), new RegExp(secret));

  const degradedSink = new MemoryEventSink({ failOnAppend: true });
  const degraded = createHarness({ eventSink: degradedSink });
  const result = await start(degraded);
  assert.equal(result.telemetryDegraded, true);
  const view = await degraded.kernel.inspect(degraded.sessionId);
  assert.equal(view.revision, 1);
  assert.equal(view.telemetry.degradedEvents.length, 1);
});

test("el presupuesto de contexto rechaza exceso y deduplica referencias portables", async () => {
  const harness = createHarness({ configuration: { contextBudgetBytes: 12 } });
  await start(harness);
  await plan(harness);
  const revision = (await harness.kernel.inspect(harness.sessionId)).revision;
  await assert.rejects(
    apply(harness, "dispatch-attempt", {
      attemptId: commandId("too-large"),
      contextManifest: [{ path: "src/large.mjs", hash: digestObject("large"), bytes: 13 }],
      findings: [],
      objective: "Implementar.",
      role: "implementador",
      rules: "Contrato.",
      tasks: "Unidad.",
      workUnitId: "unit-1",
    }),
    { code: "context_budget_exceeded" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, revision);
  await assert.rejects(
    apply(harness, "dispatch-attempt", {
      attemptId: commandId("protected-context"),
      contextManifest: [{ path: ".engram/private.db", hash: digestObject("private"), bytes: 1 }],
      findings: [],
      objective: "Implementar.",
      role: "implementador",
      rules: "Contrato.",
      tasks: "Unidad.",
      workUnitId: "unit-1",
    }),
    { code: "invalid_context_manifest" },
  );
  await assert.rejects(
    apply(harness, "dispatch-attempt", {
      attemptId: commandId("aliased-context"),
      contextManifest: [{ path: "src/file.mjs. ", hash: digestObject("alias"), bytes: 1 }],
      findings: [],
      objective: "Implementar.",
      role: "implementador",
      rules: "Contrato.",
      tasks: "Unidad.",
      workUnitId: "unit-1",
    }),
    { code: "invalid_context_manifest" },
  );
});

test("solo admite el schemaVersion actual y rechaza overrides de protocolo", async () => {
  for (const schemaVersion of [1, 3]) {
    const harness = createHarness();
    await assert.rejects(
      harness.kernel.apply({
        schemaVersion,
        commandId: commandId("schema-no-admitido"),
        sessionId: harness.sessionId,
        expectedRevision: 0,
        actorCapability: harness.bootstrapCapability,
        type: "start-session",
        payload: { mode: "light", lightStrategy: "compact", workflow: "feature" },
      }),
      { code: "unsupported_schema" },
    );
    assert.equal(await harness.stateStore.load(harness.sessionId), undefined);
  }

  const overridden = createHarness();
  const retiredField = ["protocol", "Flags"].join("");
  await assert.rejects(
    start(overridden, {
      [retiredField]: { mutationOwnership: "kernel", writeVersion: 2 },
    }),
    { code: "invalid_command" },
  );
  assert.equal(await overridden.stateStore.load(overridden.sessionId), undefined);

  const alternativeLight = createHarness();
  await assert.rejects(start(alternativeLight, { lightStrategy: "previous" }), {
    code: "invalid_command",
  });
  assert.equal(await alternativeLight.stateStore.load(alternativeLight.sessionId), undefined);

  const corrupted = createHarness({ sessionId: "corrupted-snapshot" });
  await start(corrupted);
  const snapshot = await corrupted.stateStore.load(corrupted.sessionId);
  snapshot.schemaVersion = 1;
  await corrupted.stateStore.save(corrupted.sessionId, snapshot);
  await assert.rejects(corrupted.kernel.inspect(corrupted.sessionId), {
    code: "state_protocol_mismatch",
  });
});

test("los validadores de runtime rechazan drift de schema y ciclos sin mutar", async () => {
  assert.throws(
    () => createHarness({ configuration: { maxEvaluationReworkCycles: 9 } }),
    /configuration contiene campos no admitidos/,
  );
  const harness = createHarness();
  await start(harness);
  await assert.rejects(
    harness.kernel.apply({
      schemaVersion: 2,
      commandId: commandId("unexpected-command-field"),
      sessionId: harness.sessionId,
      expectedRevision: 1,
      actorCapability: harness.capability,
      type: "record-user-input",
      payload: { reference: "fixture" },
      leakedMetadata: "no-admitido",
    }),
    { code: "invalid_command" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, 1);
  const { hash: _hash, ...contractFields } = harness.contract;
  const contractWithCapability = withAcceptanceContractHash({
    ...contractFields,
    actorCapability: "no-debe-persistirse",
  });
  await assert.rejects(
    plan(harness, { contract: contractWithCapability }),
    { code: "invalid_acceptance_contract" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, 1);

  const contractWithThreatDrift = acceptanceContract({
    threatModel: {
      commitPoints: [],
      enumeratedFaults: [],
      excludedFaults: [],
      inferredRollback: "prohibido",
    },
  });
  await assert.rejects(plan(harness, { contract: contractWithThreatDrift }), {
    code: "invalid_acceptance_contract",
  });
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, 1);

  harness.contract = acceptanceContract();
  await assert.rejects(
    plan(harness, {
      workUnits: [
        unit({ workUnitId: "unit-a", dependsOn: ["unit-b"], ownedPaths: ["src/a.mjs"] }),
        unit({ workUnitId: "unit-b", dependsOn: ["unit-a"], ownedPaths: ["src/b.mjs"] }),
      ],
    }),
    { code: "invalid_plan" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, 1);

  await assert.rejects(
    plan(harness, {
      workUnits: [
        unit({ workUnitId: "unit-a", ownedPaths: ["src"] }),
        unit({ workUnitId: "unit-b", ownedPaths: ["SRC/a.mjs"] }),
      ],
    }),
    { code: "invalid_plan" },
  );
  await assert.rejects(
    plan(harness, { workUnits: [unit({ ownedPaths: ["../escape.mjs"] })] }),
    { code: "invalid_plan" },
  );
  await assert.rejects(
    plan(harness, { workUnits: [unit({ workUnitId: "__proto__" })] }),
    { code: "invalid_plan" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, 1);

  await plan(harness);
  const attempt = commandId("strict-report");
  await apply(harness, "dispatch-attempt", {
    attemptId: attempt,
    contextManifest: [],
    findings: [],
    objective: "Implementar.",
    role: "implementador",
    rules: "Contrato.",
    tasks: "Unidad.",
    workUnitId: "unit-1",
  });
  const before = await harness.kernel.inspect(harness.sessionId);
  await assert.rejects(
    apply(harness, "accept-role-report", {
      attemptId: attempt,
      report: roleReport(harness, attempt, "implementador", {
        evidence: [{ kind: "invalid", leakedReference: harness.capability }],
      }),
    }),
    { code: "capability_leak" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, before.revision);
  await assert.rejects(
    apply(harness, "accept-role-report", {
      attemptId: attempt,
      report: roleReport(harness, attempt, "implementador", {
        evidence: [
          {
            kind: "command",
            commandDigest: digestObject("strict-evidence"),
            exitCode: 0,
            durationMs: 1,
            output: "no se persiste contenido completo",
          },
        ],
      }),
    }),
    { code: "invalid_role_report" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, before.revision);
  await assert.rejects(
    apply(harness, "accept-role-report", {
      attemptId: attempt,
      report: {
        ...roleReport(harness, attempt, "implementador"),
        actorCapability: "campo-prohibido",
      },
    }),
    { code: "invalid_role_report" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, before.revision);
});

test("una evaluación no admite dos intentos activos para el mismo eje y generación", async () => {
  const harness = createHarness();
  await reachEvaluation(harness, {
    mode: "full",
    strategy: "dual",
    risk: "public-compatibility-or-migration",
  });
  const firstAttempt = commandId("axis-active");
  await apply(harness, "dispatch-attempt", {
    attemptId: firstAttempt,
    contextManifest: [],
    findings: [],
    objective: "Evaluar especificación.",
    evaluationAxis: "specification",
    role: "evaluador",
    rules: "Contrato.",
    tasks: "Evaluación independiente.",
  });
  const beforeConflict = await harness.kernel.inspect(harness.sessionId);
  await assert.rejects(
    apply(harness, "dispatch-attempt", {
      attemptId: commandId("axis-duplicate"),
      contextManifest: [],
      findings: [],
      objective: "Duplicar evaluación.",
      evaluationAxis: "specification",
      role: "evaluador",
      rules: "Contrato.",
      tasks: "No debe abrir.",
    }),
    { code: "evaluation_axis_active" },
  );
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, beforeConflict.revision);
});

test("un comando retirado se rechaza y start-session es la única entrada de creación", async () => {
  const harness = createHarness({ sessionId: "retired-command" });
  const retiredCommand = ["migrate", ["v", 1].join("")].join("-");

  await assert.rejects(
    harness.kernel.apply({
      schemaVersion: 2,
      commandId: commandId("retired-command"),
      sessionId: harness.sessionId,
      expectedRevision: 0,
      actorCapability: harness.bootstrapCapability,
      type: retiredCommand,
      payload: {},
    }),
    { code: "unknown_command" },
  );
  assert.equal(await harness.stateStore.load(harness.sessionId), undefined);
  await assert.rejects(harness.kernel.inspect(harness.sessionId), { code: "session_not_found" });

  const started = await start(harness);
  assert.equal(started.decision, "started");
  assert.equal((await harness.kernel.inspect(harness.sessionId)).schemaVersion, 2);
});

test("MemoryStateStore y FileSystemStateStore cumplen la misma superficie pública", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentic-kernel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = [new MemoryStateStore(), new FileSystemStateStore({ root })];
  const surfaces = stores.map((store) =>
    Object.getOwnPropertyNames(Object.getPrototypeOf(store))
      .filter((name) => name !== "constructor")
      .sort(),
  );
  assert.deepEqual(surfaces[0], surfaces[1]);
  assert.deepEqual(surfaces[0], [
    "acquireWriter",
    "findActiveWriter",
    "findCommand",
    "load",
    "probe",
    "releaseWriter",
    "save",
    "withGlobalLock",
    "withLock",
    "workingTreeId",
  ]);

  for (const stateStore of stores) {
    const harness = createHarness({ stateStore });
    await start(harness);
    await plan(harness);
    const view = await harness.kernel.inspect(harness.sessionId);
    assert.equal(view.schemaVersion, 2);
    assert.equal(view.revision, 2);
    assert.equal(view.lifecycle, "executing");
    assert.equal(view.acceptanceContractHash, harness.contract.hash);
  }
});

test("FileSystemStateStore compone snapshot atómico y event log JSONL append-only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentic-kernel-filesystem-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateStore = new FileSystemStateStore({ root });
  const bootstrapCapability = createBootstrapCapability();
  const kernel = new OrchestrationKernel({
    bootstrapCapability,
    clock: new FakeClock(),
    environmentProbe: new FakeEnvironmentProbe(),
    stateStore,
  });
  const result = await kernel.apply({
    schemaVersion: 2,
    commandId: commandId("filesystem-start"),
    sessionId: "filesystem-session",
    expectedRevision: 0,
    actorCapability: bootstrapCapability,
    type: "start-session",
    payload: { mode: "full", workflow: "feature" },
  });
  assert.equal(result.revision, 1);
  const snapshot = JSON.parse(
    await readFile(join(root, ".agents", "sessions", "state", "filesystem-session", "snapshot.json"), "utf8"),
  );
  const events = (await readFile(join(root, ".agents", "sessions", "state", "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, "orchestrator");
  assert.equal(events[0].commandType, "start-session");
  const restartedEventSink = new JsonlEventSink({
    path: join(root, ".agents", "sessions", "state", "events.jsonl"),
  });
  assert.deepEqual(await restartedEventSink.append(events[0]), { duplicate: true });
  assert.equal(
    (await readFile(join(root, ".agents", "sessions", "state", "events.jsonl"), "utf8"))
      .trim()
      .split("\n").length,
    1,
  );
  const snapshotPath = join(
    root,
    ".agents",
    "sessions",
    "state",
    "filesystem-session",
    "snapshot.json",
  );
  await writeFile(snapshotPath, '{"schemaVersion":2', "utf8");
  await assert.rejects(kernel.inspect("filesystem-session"), (error) => {
    assert.equal(error.code, "state_snapshot_invalid");
    assert.equal(error.details.operation, "parse-snapshot");
    assert.equal(error.details.path, snapshotPath);
    assert.ok(error.details.remedy);
    return true;
  });
});

test("FileSystemStateStore rechaza ancestros redirigidos antes de escribir fuera de root", async (t) => {
  const linkType = process.platform === "win32" ? "junction" : "dir";
  for (const redirectedAncestor of ["state", "session"]) {
    await t.test(redirectedAncestor, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `agentic-kernel-${redirectedAncestor}-root-`));
      const outside = await mkdtemp(join(tmpdir(), `agentic-kernel-${redirectedAncestor}-outside-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      t.after(() => rm(outside, { recursive: true, force: true }));
      const sessionId = `redirected-${redirectedAncestor}`;
      const baseDirectory = join(root, ".agents", "sessions", "state");
      if (redirectedAncestor === "state") {
        await mkdir(dirname(baseDirectory), { recursive: true });
        await symlink(outside, baseDirectory, linkType);
      } else {
        await mkdir(baseDirectory, { recursive: true });
        await symlink(outside, join(baseDirectory, sessionId), linkType);
      }
      const harness = createHarness({
        sessionId,
        stateStore: new FileSystemStateStore({ root }),
      });

      await assert.rejects(start(harness), (error) => {
        assert.equal(error.code, "state_path_unsafe");
        assert.ok(error.details.path);
        assert.ok(error.details.remedy);
        return true;
      });
      assert.deepEqual(await readdir(outside), []);
    });
  }
});

test("FileSystemStateStore rechaza un snapshot enlazado físicamente fuera de root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentic-kernel-hardlink-root-"));
  const outside = await mkdtemp(join(tmpdir(), "agentic-kernel-hardlink-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sessionId = "hardlink-snapshot";
  const harness = createHarness({
    sessionId,
    stateStore: new FileSystemStateStore({ root }),
  });
  await start(harness);
  const snapshotPath = join(
    root,
    ".agents",
    "sessions",
    "state",
    sessionId,
    "snapshot.json",
  );
  const outsidePath = join(outside, "snapshot.json");
  const source = await readFile(snapshotPath, "utf8");
  await rm(snapshotPath);
  await writeFile(outsidePath, source, "utf8");
  await link(outsidePath, snapshotPath);

  await assert.rejects(harness.kernel.inspect(sessionId), { code: "state_path_unsafe" });
  assert.equal(await readFile(outsidePath, "utf8"), source);
});

test("FileSystemStateStore crea, reemplaza e inspecciona snapshots tras reiniciar el host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentic-kernel-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "filesystem-restart";
  const startCommandId = commandId("filesystem-restart-start");
  const first = createHarness({
    sessionId,
    stateStore: new FileSystemStateStore({ root }),
  });
  await start(first, { mode: "full" }, { commandId: startCommandId });
  await plan(first);
  const snapshotPath = join(
    root,
    ".agents",
    "sessions",
    "state",
    sessionId,
    "snapshot.json",
  );
  assert.equal(JSON.parse(await readFile(snapshotPath, "utf8")).revision, 2);

  const restarted = createHarness({
    sessionId,
    stateStore: new FileSystemStateStore({ root }),
  });
  const recovered = await start(restarted, { mode: "full" }, { commandId: startCommandId });
  assert.equal(recovered.revision, 1);
  const inspected = await restarted.kernel.inspect(sessionId);
  assert.equal(inspected.revision, 2);
  assert.equal(inspected.lifecycle, "executing");
  assert.deepEqual(await readdir(dirname(snapshotPath)), ["snapshot.json"]);
});

test("FileSystemStateStore recupera locks de mutación abandonados sin usar antigüedad", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentic-kernel-abandoned-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseDirectory = join(root, ".agents", "sessions", "state");
  await mkdir(baseDirectory, { recursive: true });
  const abandonedOwner = { pid: 2_147_483_647, token: "abandoned-owner" };
  const candidatePath = join(
    baseDirectory,
    `.global.lock.tmp-${abandonedOwner.pid}-${abandonedOwner.token}`,
  );
  await writeFile(candidatePath, JSON.stringify(abandonedOwner), "utf8");
  await link(candidatePath, join(baseDirectory, ".global.lock"));
  const harness = createHarness({
    sessionId: "abandoned-lock",
    stateStore: new FileSystemStateStore({ root }),
  });

  const started = await start(harness);
  assert.equal(started.decision, "started");
  assert.equal((await readdir(baseDirectory)).includes(".global.lock"), false);
  assert.equal((await readdir(baseDirectory)).includes(candidatePath.split(/[\\/]/).at(-1)), false);
});

test("FileSystemStateStore conserva locks ambiguos sin limpieza oportunista", async (t) => {
  await t.test("mutation lock", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agentic-kernel-ambiguous-mutation-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const baseDirectory = join(root, ".agents", "sessions", "state");
    const lockPath = join(baseDirectory, ".global.lock");
    await mkdir(baseDirectory, { recursive: true });
    await writeFile(lockPath, "owner-incompleto", "utf8");
    const harness = createHarness({
      sessionId: "ambiguous-mutation",
      stateStore: new FileSystemStateStore({ root }),
    });

    await assert.rejects(start(harness), { code: "session_lock_ambiguous" });
    assert.equal(await readFile(lockPath, "utf8"), "owner-incompleto");
  });

  await t.test("writer lock", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agentic-kernel-ambiguous-writer-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stateStore = new FileSystemStateStore({ root });
    const harness = createHarness({ sessionId: "ambiguous-writer", stateStore });
    await start(harness);
    await plan(harness);
    const lockPath = join(
      root,
      ".agents",
      "sessions",
      "state",
      `.writer-${await stateStore.workingTreeId()}.lock`,
    );
    await writeFile(lockPath, "owner-incompleto", "utf8");

    await assert.rejects(
      dispatchWriter(harness, commandId("ambiguous-writer-attempt")),
      { code: "writer_lock_ambiguous" },
    );
    assert.equal(await readFile(lockPath, "utf8"), "owner-incompleto");
  });
});

test("el recorrido full feliz usa una validación, eventos atribuibles y termina completed", async () => {
  const harness = createHarness();
  await reachEvaluation(harness, {
    mode: "full",
    strategy: "dual",
    risk: "public-compatibility-or-migration",
  });
  await evaluate(harness, [{ decision: "pass" }, { decision: "pass" }], "dual");
  let view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.lifecycle, "completed");
  assert.equal(Object.keys(view.validations).length, 1);
  assert.ok(Object.keys(view.attempts).length <= 6);
  assert.equal(harness.eventSink.events.every((event) => event.actor === "orchestrator"), true);
  const closed = await apply(harness, "close-session");
  assert.equal(closed.finalState, "completed");
  view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.closed, true);
  await assert.rejects(apply(harness, "record-user-input", { reference: "reactivar" }), {
    code: "session_terminal",
  });
});

test("light compact consolida la única unidad en el Evaluador sin abrir Tester posterior", async () => {
  const harness = createHarness();
  await start(harness, { mode: "light", lightStrategy: "compact" });
  await plan(harness);
  await dispatchAndReport(harness, { role: "implementador", workUnitId: "unit-1" });
  let view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.lifecycle, "evaluating");
  assert.equal(view.workUnits["unit-1"].status, "implemented");
  await evaluate(harness, [{ decision: "pass" }]);
  view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.lifecycle, "completed");
  assert.equal(view.workUnits["unit-1"].status, "validated");
  assert.equal(
    Object.values(view.attempts).some((attempt) => attempt.role === "tester"),
    false,
  );
});

test("bugfix compact permite reproducción y planificación trazables antes del contrato", async () => {
  const harness = createHarness();
  await start(harness, { mode: "light", lightStrategy: "compact", workflow: "bugfix" });
  let planningHash;
  for (const { role, phase } of [
    { role: "tester", phase: "bugfix-reproduce" },
    { role: "planificador", phase: "bugfix-plan" },
  ]) {
    const attemptId = commandId(phase);
    const dispatched = await apply(harness, "dispatch-attempt", {
      attemptId,
      contextManifest: [],
      findings: [],
      objective: `Ejecutar ${phase}.`,
      phase,
      role,
      rules: "Scope inicial inmutable.",
      tasks: "Devolver reporte estructurado.",
    });
    assert.equal(dispatched.envelope.contractKind, "planning-scope");
    planningHash ??= dispatched.envelope.acceptanceContractHash;
    assert.equal(dispatched.envelope.acceptanceContractHash, planningHash);
    await apply(harness, "accept-role-report", {
      attemptId,
      report: roleReport(harness, attemptId, role, {
        acceptanceContractHash: dispatched.envelope.acceptanceContractHash,
      }),
    });
    assert.equal((await harness.kernel.inspect(harness.sessionId)).lifecycle, "planning");
  }
  await plan(harness);
  const implemented = await dispatchAndReport(harness, {
    role: "implementador",
    workUnitId: "unit-1",
  });
  assert.equal(implemented.dispatched.envelope.contractKind, "acceptance");
  await evaluate(harness, [{ decision: "pass" }]);
  assert.equal((await harness.kernel.inspect(harness.sessionId)).lifecycle, "completed");
});

test("architecture sin implementación evalúa y documenta la decisión sin unidad ficticia", async () => {
  const harness = createHarness();
  await start(harness, { mode: "full", workflow: "architecture" });
  await apply(harness, "accept-plan", {
    acceptanceContract: harness.contract,
    documentationRequired: true,
    documentationReason: "Decisión arquitectónica durable.",
    evaluationRisk: "architectural-decision",
    evaluationStrategy: "combined",
    workUnits: [],
  });
  let view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.lifecycle, "evaluating");
  assert.deepEqual(view.workUnits, {});
  await evaluate(harness, [{ decision: "pass" }]);
  assert.equal((await harness.kernel.inspect(harness.sessionId)).lifecycle, "documenting");
  await dispatchAndReport(harness, { role: "documentador" });
  view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.lifecycle, "completed");
  assert.equal(
    Object.values(view.attempts).some((attempt) =>
      ["implementador", "tester"].includes(attempt.role),
    ),
    false,
  );
});

test("un retrabajo legítimo invalida evidencia y resuelve el finding con identidad estable", async () => {
  const harness = createHarness();
  await reachEvaluation(harness, { mode: "full" });
  const [rejected] = await evaluate(harness, [
    { decision: "fail", findings: [finding("acceptance_violation", { findingId: "F-STABLE" })] },
  ]);
  assert.equal(rejected.evaluationReworkCycle, 1);
  let view = await harness.kernel.inspect(harness.sessionId);
  const fingerprint = Object.keys(view.findings)[0];
  assert.equal(view.generation, 2);
  assert.deepEqual(view.validations, {});

  await rebuildAfterEvaluation(harness, "full");
  const [approved] = await evaluate(harness, [{ decision: "pass" }]);
  assert.equal(approved.state, "completed");
  view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.evaluationReworkCycles, 1);
  assert.equal(view.findings[fingerprint].status, "resolved");
  assert.equal(view.findings[fingerprint].resolvedGeneration, 2);
  assert.ok(Object.keys(view.attempts).length <= 10);
});

test("un timeout concurrente tiene un solo efecto y el comando distinto queda stale", async () => {
  const harness = createHarness();
  const startCommand = {
    schemaVersion: 2,
    commandId: commandId("concurrent-start"),
    sessionId: harness.sessionId,
    expectedRevision: 0,
    actorCapability: harness.bootstrapCapability,
    type: "start-session",
    payload: { mode: "light", lightStrategy: "compact", workflow: "feature" },
  };
  const [first, retry] = await Promise.all([
    harness.kernel.apply(startCommand),
    harness.kernel.apply(startCommand),
  ]);
  harness.capability = first.actorCapability;
  assert.equal(first.revision, retry.revision);
  assert.equal(harness.eventSink.events.length, 1);

  const payload = {
    acceptanceContract: harness.contract,
    documentationRequired: false,
    workUnits: [unit()],
  };
  const commands = ["a", "b"].map((suffix) => ({
    schemaVersion: 2,
    commandId: commandId(`concurrent-${suffix}`),
    sessionId: harness.sessionId,
    expectedRevision: 1,
    actorCapability: harness.capability,
    type: "accept-plan",
    payload,
  }));
  const settled = await Promise.allSettled(commands.map((item) => harness.kernel.apply(item)));
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = settled.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "stale_revision");
  assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, 2);
});

test("un retry recupera el evento pendiente cuando el snapshot ya quedó comprometido", async () => {
  class CommitThenTimeoutStore extends MemoryStateStore {
    failAfterFirstCommit = true;

    async save(sessionId, snapshot) {
      await super.save(sessionId, snapshot);
      if (this.failAfterFirstCommit) {
        this.failAfterFirstCommit = false;
        throw Object.assign(new Error("Timeout después del commit durable."), { code: "ETIMEDOUT" });
      }
    }
  }

  const stateStore = new CommitThenTimeoutStore();
  const harness = createHarness({ stateStore });
  const startCommandId = commandId("commit-then-timeout");
  await assert.rejects(start(harness, {}, { commandId: startCommandId }), {
    code: "ETIMEDOUT",
  });
  let snapshot = await stateStore.load(harness.sessionId);
  assert.equal(snapshot.revision, 1);
  assert.equal(Object.keys(snapshot.telemetry.pendingEvents).length, 1);
  assert.equal(harness.eventSink.events.length, 0);

  const recovered = await start(harness, {}, { commandId: startCommandId });
  assert.equal(recovered.decision, "started");
  assert.equal(recovered.revision, 1);
  snapshot = await stateStore.load(harness.sessionId);
  assert.equal(Object.keys(snapshot.commands).length, 1);
  assert.equal(Object.keys(snapshot.telemetry.pendingEvents).length, 0);
  assert.equal(harness.eventSink.events.length, 1);
  assert.equal(harness.eventSink.events[0].commandId, startCommandId);
});

test("commandId es global y una colisión entre sesiones falla sin filtrar autoridad", async () => {
  const stateStore = new MemoryStateStore();
  const first = createHarness({ sessionId: "global-command-a", stateStore });
  const second = createHarness({ sessionId: "global-command-b", stateStore });
  const sharedCommandId = commandId("global-command");
  await start(first, {}, { commandId: sharedCommandId });
  await assert.rejects(start(second, {}, { commandId: sharedCommandId }), {
    code: "idempotency_conflict",
  });
  assert.equal(await stateStore.load(second.sessionId), undefined);
});

test("secuencias generadas conservan las diez invariantes normativas", async () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    try {
      let randomState = seed >>> 0;
      const random = () => {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        return randomState / 0x1_0000_0000;
      };
      const mode = random() < 0.5 ? "full" : "light";
      const strategy = mode === "light" || random() < 0.5 ? "combined" : "dual";
      const harness = createHarness({ sessionId: `property-${seed}` });
      await reachEvaluation(harness, {
        mode,
        strategy,
        risk: strategy === "dual" ? "public-compatibility-or-migration" : undefined,
      });

      const beforeUnauthorized = await harness.kernel.inspect(harness.sessionId);
      await assert.rejects(
        apply(
          harness,
          "record-user-input",
          { reference: "actor-no-autorizado" },
          { actorCapability: Object.freeze(Object.create(null)) },
        ),
        { code: "actor_not_authorized" },
      );
      assert.deepEqual(await harness.kernel.inspect(harness.sessionId), beforeUnauthorized);

      const branch = Math.floor(random() * 4);
      let expectedReworkCycles = 0;
      if (branch === 0) {
        await evaluate(
          harness,
          strategy === "dual" ? [{ decision: "pass" }, { decision: "pass" }] : [{ decision: "pass" }],
          strategy,
        );
      } else if (branch === 1) {
        await evaluate(
          harness,
          strategy === "dual"
            ? [
                { decision: "fail", findings: [finding("acceptance_violation")] },
                { decision: "pass" },
              ]
            : [{ decision: "fail", findings: [finding("acceptance_violation")] }],
          strategy,
        );
        expectedReworkCycles = 1;
        await rebuildAfterEvaluation(harness, mode);
        await evaluate(
          harness,
          strategy === "dual" ? [{ decision: "pass" }, { decision: "pass" }] : [{ decision: "pass" }],
          strategy,
        );
      } else if (branch === 2) {
        const reports = strategy === "dual"
          ? [
              {
                decision: "fail",
                findings: [finding("novel_adversarial_finding", { severity: "critical" })],
              },
              { decision: "pass" },
            ]
          : [
              {
                decision: "fail",
                findings: [finding("novel_adversarial_finding", { severity: "critical" })],
              },
            ];
        await evaluate(harness, reports, strategy);
        const paused = await harness.kernel.inspect(harness.sessionId);
        assert.equal(paused.lifecycle, "scope_decision_required");
        assert.equal(
          Object.values(paused.attempts).some(
            (attempt) => attempt.state === "active" && attempt.permission === "writer",
          ),
          false,
        );
        await apply(harness, "resolve-scope-decision", {
          action: random() < 0.5 ? "defer" : "accept-risk",
          reference: `property-resolution-${seed}`,
        });
      } else {
        const reports = strategy === "dual"
          ? [
              {
                decision: "fail",
                findings: [finding("novel_adversarial_finding", { severity: "medium" })],
              },
              { decision: "pass" },
            ]
          : [
              {
                decision: "fail",
                findings: [finding("novel_adversarial_finding", { severity: "medium" })],
              },
            ];
        await evaluate(harness, reports, strategy);
      }

      const finalView = await harness.kernel.inspect(harness.sessionId);
      assert.equal(finalView.acceptanceContractHash, harness.contract.hash);
      assert.equal(finalView.evaluationReworkCycles, expectedReworkCycles);
      assert.ok(["completed", "closed_rejected"].includes(finalView.lifecycle));
      for (const storedFinding of Object.values(finalView.findings)) {
        if (storedFinding.classification === "acceptance_violation") {
          assert.ok(storedFinding.criterionIds.length > 0);
        }
        if (storedFinding.classification === "transversal_policy_violation") {
          assert.ok(storedFinding.policyIds.length > 0);
        }
      }

      const revisions = harness.eventSink.events.map((event) => event.toRevision);
      assert.equal(new Set(revisions).size, revisions.length);
      assert.equal(finalView.revision, revisions.length);
      for (let index = 0; index < harness.eventSink.events.length; index += 1) {
        const event = harness.eventSink.events[index];
        assert.equal(event.fromRevision + 1, event.toRevision);
        if (index > 0) assert.ok(event.toRevision > revisions[index - 1]);
      }

      const terminalRevision = finalView.revision;
      await assert.rejects(apply(harness, "record-user-input", { reference: "reactivar" }), {
        code: "session_terminal",
      });
      assert.equal((await harness.kernel.inspect(harness.sessionId)).revision, terminalRevision);
    } catch (error) {
      error.message = `seed=${seed}: ${error.message}`;
      throw error;
    }
  }
});

test("la reserva de writer es única entre sesiones del mismo StateStore", async () => {
  const stateStore = new MemoryStateStore();
  const first = createHarness({ sessionId: "writer-session-a", stateStore });
  const second = createHarness({ sessionId: "writer-session-b", stateStore });
  await start(first);
  await plan(first);
  await start(second);
  await plan(second);

  const firstAttempt = commandId("writer-first");
  await apply(first, "dispatch-attempt", {
    attemptId: firstAttempt,
    contextManifest: [],
    findings: [],
    objective: "Implementar A.",
    role: "implementador",
    rules: "Contrato.",
    tasks: "Unidad.",
    workUnitId: "unit-1",
  });
  await assert.rejects(
    apply(second, "dispatch-attempt", {
      attemptId: commandId("writer-blocked"),
      contextManifest: [],
      findings: [],
      objective: "Implementar B.",
      role: "implementador",
      rules: "Contrato.",
      tasks: "Unidad.",
      workUnitId: "unit-1",
    }),
    { code: "writer_locked" },
  );
  await apply(first, "accept-role-report", {
    attemptId: firstAttempt,
    report: roleReport(first, firstAttempt, "implementador"),
  });
  const released = await apply(second, "dispatch-attempt", {
    attemptId: commandId("writer-after-release"),
    contextManifest: [],
    findings: [],
    objective: "Implementar B.",
    role: "implementador",
    rules: "Contrato.",
    tasks: "Unidad.",
    workUnitId: "unit-1",
  });
  assert.equal(released.envelope.role, "implementador");
});

test("una interrupción cierra el intento sin fabricar RoleReport y libera el writer", async () => {
  const harness = createHarness();
  await start(harness);
  await plan(harness);
  const interruptedAttempt = commandId("writer-interrupted");
  await apply(harness, "dispatch-attempt", {
    attemptId: interruptedAttempt,
    contextManifest: [],
    findings: [],
    objective: "Implementar.",
    role: "implementador",
    rules: "Contrato.",
    tasks: "Unidad.",
    workUnitId: "unit-1",
  });
  const failed = await apply(harness, "record-attempt-failure", {
    attemptId: interruptedAttempt,
    reason: "El proceso terminó antes de emitir reporte.",
    retryCause: "timeout",
  });
  assert.equal(failed.decision, "attempt_failed");
  const view = await harness.kernel.inspect(harness.sessionId);
  assert.equal(view.attempts[interruptedAttempt].state, "failed");
  assert.equal("report" in view.attempts[interruptedAttempt], false);
  assert.equal(view.workUnits["unit-1"].status, "needs_rework");
  const retry = await apply(harness, "dispatch-attempt", {
    attemptId: commandId("writer-retry"),
    contextManifest: [],
    findings: [],
    objective: "Reintentar implementación.",
    retryCause: "timeout",
    role: "implementador",
    rules: "Contrato.",
    tasks: "Unidad.",
    workUnitId: "unit-1",
  });
  assert.equal(retry.envelope.role, "implementador");
  assert.equal(harness.eventSink.events.at(-1).retryCause, "timeout");
});

test("FileSystemStateStore persiste el dueño exacto y atribuye conflictos entre DevSessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentic-kernel-writer-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = createHarness({
    sessionId: "filesystem-writer-a",
    stateStore: new FileSystemStateStore({ root }),
  });
  const second = createHarness({
    sessionId: "filesystem-writer-b",
    stateStore: new FileSystemStateStore({ root }),
  });
  await start(first);
  await plan(first);
  await start(second);
  await plan(second);

  const firstAttempt = commandId("filesystem-writer-first");
  await dispatchWriter(first, firstAttempt);
  const { reservation } = await readWriterReservation(root);
  assert.deepEqual(reservation.owner, {
    attempt: firstAttempt,
    session: first.sessionId,
    workingTreeId: reservation.owner.workingTreeId,
  });
  assert.match(reservation.owner.workingTreeId, /^[a-f0-9]{64}$/);
  const blockedAttempt = commandId("filesystem-writer-blocked");
  await assert.rejects(dispatchWriter(second, blockedAttempt), (error) => {
    assert.equal(error.code, "writer_locked");
    assert.deepEqual(error.details, reservation.owner);
    assert.match(error.message, new RegExp(`${first.sessionId}/${firstAttempt}`));
    return true;
  });

  await apply(first, "accept-role-report", {
    attemptId: firstAttempt,
    report: roleReport(first, firstAttempt, "implementador"),
  });
  const stateDirectory = join(root, ".agents", "sessions", "state");
  assert.equal((await readdir(stateDirectory)).some((name) => name.startsWith(".writer-")), false);
  const released = await dispatchWriter(second, commandId("filesystem-writer-after-release"));
  assert.equal(released.envelope.role, "implementador");
});

test("un retry exacto recupera el checkpoint de una reserva publicada antes del snapshot", async (t) => {
  class InterruptWriterSnapshotStore extends FileSystemStateStore {
    interruptNextWriterSnapshot = false;

    async save(sessionId, snapshot) {
      if (
        this.interruptNextWriterSnapshot &&
        Object.values(snapshot.attempts ?? {}).some(
          (attempt) => attempt.state === "active" && attempt.permission === "writer",
        )
      ) {
        this.interruptNextWriterSnapshot = false;
        throw Object.assign(new Error("Interrupción antes del snapshot writer."), { code: "EIO" });
      }
      return super.save(sessionId, snapshot);
    }
  }

  const root = await mkdtemp(join(tmpdir(), "agentic-kernel-writer-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateStore = new InterruptWriterSnapshotStore({ root });
  const harness = createHarness({ sessionId: "writer-checkpoint", stateStore });
  await start(harness);
  await plan(harness);
  const attemptId = commandId("writer-checkpoint-attempt");
  const dispatchCommandId = commandId("writer-checkpoint-dispatch");
  stateStore.interruptNextWriterSnapshot = true;

  await assert.rejects(
    dispatchWriter(harness, attemptId, { commandId: dispatchCommandId }),
    { code: "EIO" },
  );
  const beforeRetry = await readWriterReservation(root);
  assert.deepEqual(beforeRetry.reservation.owner, {
    attempt: attemptId,
    session: harness.sessionId,
    workingTreeId: beforeRetry.reservation.owner.workingTreeId,
  });
  assert.equal(beforeRetry.reservation.checkpoint.commandId, dispatchCommandId);
  assert.equal(beforeRetry.reservation.checkpoint.expectedRevision, 2);

  const recovered = await dispatchWriter(harness, attemptId, { commandId: dispatchCommandId });
  assert.equal(recovered.envelope.attemptId, attemptId);
  assert.deepEqual(await readWriterReservation(root), beforeRetry);
});

test("un retry terminal libera una reserva propia demostrada por el snapshot", async (t) => {
  class InterruptWriterReleaseStore extends FileSystemStateStore {
    interruptNextRelease = false;

    async releaseWriter(...arguments_) {
      if (this.interruptNextRelease) {
        this.interruptNextRelease = false;
        throw Object.assign(new Error("Interrupción después del snapshot terminal."), { code: "EIO" });
      }
      return super.releaseWriter(...arguments_);
    }
  }

  const root = await mkdtemp(join(tmpdir(), "agentic-kernel-writer-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "writer-recovery";
  const startCommandId = commandId("writer-recovery-start");
  const stateStore = new InterruptWriterReleaseStore({ root });
  const harness = createHarness({ sessionId, stateStore });
  await start(harness, {}, { commandId: startCommandId });
  await plan(harness);
  const attemptId = commandId("writer-recovery-attempt");
  await dispatchWriter(harness, attemptId);
  const report = roleReport(harness, attemptId, "implementador");
  const terminalCommandId = commandId("writer-recovery-terminal");
  stateStore.interruptNextRelease = true;

  await assert.rejects(
    apply(
      harness,
      "accept-role-report",
      { attemptId, report },
      { commandId: terminalCommandId },
    ),
    { code: "EIO" },
  );
  assert.equal((await harness.kernel.inspect(sessionId)).attempts[attemptId].state, "completed");
  await readWriterReservation(root);

  const restarted = createHarness({
    sessionId,
    stateStore: new FileSystemStateStore({ root }),
  });
  await start(restarted, {}, { commandId: startCommandId });
  const retried = await apply(
    restarted,
    "accept-role-report",
    { attemptId, report },
    { commandId: terminalCommandId, expectedRevision: 3 },
  );
  assert.equal(retried.revision, 4);
  const stateDirectory = join(root, ".agents", "sessions", "state");
  assert.equal((await readdir(stateDirectory)).some((name) => name.startsWith(".writer-")), false);

  const contender = createHarness({
    sessionId: "writer-recovery-contender",
    stateStore: new FileSystemStateStore({ root }),
  });
  await start(contender);
  await plan(contender);
  assert.equal(
    (await dispatchWriter(contender, commandId("writer-recovery-after"))).envelope.role,
    "implementador",
  );
});

test("un retry terminal preserva sin cambios la reserva de un writer sucesor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentic-kernel-writer-successor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = createHarness({
    sessionId: "writer-successor-first",
    stateStore: new FileSystemStateStore({ root }),
  });
  const successor = createHarness({
    sessionId: "writer-successor-second",
    stateStore: new FileSystemStateStore({ root }),
  });
  const contender = createHarness({
    sessionId: "writer-successor-third",
    stateStore: new FileSystemStateStore({ root }),
  });
  for (const harness of [first, successor, contender]) {
    await start(harness);
    await plan(harness);
  }

  const firstAttempt = commandId("writer-successor-original");
  await dispatchWriter(first, firstAttempt);
  const firstReport = roleReport(first, firstAttempt, "implementador");
  const terminalCommandId = commandId("writer-successor-terminal");
  await apply(
    first,
    "accept-role-report",
    { attemptId: firstAttempt, report: firstReport },
    { commandId: terminalCommandId },
  );
  const successorAttempt = commandId("writer-successor-current");
  await dispatchWriter(successor, successorAttempt);
  const beforeRetry = await readWriterReservation(root);

  const retried = await apply(
    first,
    "accept-role-report",
    { attemptId: firstAttempt, report: firstReport },
    { commandId: terminalCommandId, expectedRevision: 3 },
  );
  assert.equal(retried.revision, 4);
  assert.deepEqual(await readWriterReservation(root), beforeRetry);
  await assert.rejects(
    dispatchWriter(contender, commandId("writer-successor-blocked")),
    (error) => {
      assert.equal(error.code, "writer_locked");
      assert.equal(error.details.session, successor.sessionId);
      assert.equal(error.details.attempt, successorAttempt);
      return true;
    },
  );
});

test("la conformidad exige inventario, schemas y marcadores canónicos", async (t) => {
  const manifest = JSON.parse(await readFile(join(ROOT, ".agents", "protocol.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), [
    "allowedOverrides",
    "artifacts",
    "distributionVersion",
    "kernelInterface",
    "schemaVersion",
  ]);
  assert.deepEqual(manifest.allowedOverrides, ["contextBudgetBytes", "telemetrySink"]);

  const canonical = await assertProtocolConformance({
    root: ROOT,
    overrides: { contextBudgetBytes: 64_000, telemetrySink: "jsonl-local" },
  });
  assert.equal(canonical.schemaVersion, 2);
  assert.equal(canonical.distributionVersion, "0.2.0");
  assert.match(canonical.artifactHash, /^sha256:[0-9a-f]{64}$/);
  await assert.rejects(
    assertProtocolConformance({ root: ROOT, overrides: { kernelInterface: ["apply", "inspect", "drift"] } }),
    { code: "conformance_override_drift" },
  );

  const fixtureRoot = await mkdtemp(join(tmpdir(), "agentic-conformance-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await cp(join(ROOT, ".agents"), join(fixtureRoot, ".agents"), { recursive: true });
  await cp(join(ROOT, ".codex"), join(fixtureRoot, ".codex"), { recursive: true });
  await cp(join(ROOT, ".claude"), join(fixtureRoot, ".claude"), { recursive: true });
  await cp(join(ROOT, "CLAUDE.md"), join(fixtureRoot, "CLAUDE.md"));
  await writeFile(
    join(fixtureRoot, "package.json"),
    `${JSON.stringify({ name: "consumer-fixture", version: "7.4.0" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(fixtureRoot, ".agents", "VERSION"), "0.2.0\n", "utf8");
  assert.equal((await assertProtocolConformance({ root: fixtureRoot })).schemaVersion, 2);
  const rolePath = join(fixtureRoot, ".agents", "roles", "tester.md");
  const roleSource = await readFile(rolePath, "utf8");
  await writeFile(rolePath, roleSource.replace("<!-- agentic-role-report -->", ""), "utf8");
  await assert.rejects(assertProtocolConformance({ root: fixtureRoot }), {
    code: "conformance_version_mismatch",
  });
  await writeFile(rolePath, roleSource, "utf8");

  const claudeSkillPath = join(fixtureRoot, ".claude", "skills", "orquestar", "SKILL.md");
  const claudeSkillSource = await readFile(claudeSkillPath, "utf8");
  await writeFile(
    claudeSkillPath,
    claudeSkillSource.replace("<!-- agentic-protocol -->", ""),
    "utf8",
  );
  await assert.rejects(assertProtocolConformance({ root: fixtureRoot }), {
    code: "conformance_version_mismatch",
  });
  await writeFile(claudeSkillPath, claudeSkillSource, "utf8");

  const schemaPath = join(fixtureRoot, ".agents", "schemas", "role-report.schema.json");
  const missingSchemaPath = `${schemaPath}.missing`;
  await rename(schemaPath, missingSchemaPath);
  await assert.rejects(assertProtocolConformance({ root: fixtureRoot }), {
    code: "conformance_missing_artifact",
  });
  await rename(missingSchemaPath, schemaPath);

  const protocolPath = join(fixtureRoot, ".agents", "protocol.json");
  const protocolSource = await readFile(protocolPath, "utf8");
  const protocol = JSON.parse(protocolSource);
  protocol.distributionVersion = "9.9.9";
  await writeFile(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`, "utf8");
  await assert.rejects(assertProtocolConformance({ root: fixtureRoot }), {
    code: "conformance_version_mismatch",
  });
  await writeFile(protocolPath, protocolSource, "utf8");

  const kernelPath = join(fixtureRoot, ".agents", "kernel", "orchestration-kernel.mjs");
  const kernelSource = await readFile(kernelPath, "utf8");
  await writeFile(
    kernelPath,
    kernelSource.replace(
      "export class OrchestrationKernel {",
      "export class OrchestrationKernel {\n  unsupportedDrift() {}",
    ),
    "utf8",
  );
  await assert.rejects(assertProtocolConformance({ root: fixtureRoot }), {
    code: "conformance_kernel_interface_drift",
  });
});
