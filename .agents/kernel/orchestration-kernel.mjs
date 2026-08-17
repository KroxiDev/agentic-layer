// agentic-kernel
import {
  MemoryCapabilityRegistry,
  MemoryEventSink,
  SystemClock,
  SystemEnvironmentProbe,
  validationFingerprint,
} from "./adapters.mjs";
import {
  KernelError,
  SCHEMA_VERSION,
  acceptanceContractHash,
  assertNonEmptyString,
  assertOpaqueIdentifier,
  assertRecord,
  clone,
  commandFingerprint,
  deepFreeze,
  digestObject,
  eventId,
  validateBaseCommand,
  validateSessionId,
} from "./protocol.mjs";

const COMMAND_TYPES = new Set([
  "accept-plan",
  "accept-role-report",
  "amend-scope",
  "close-session",
  "dispatch-attempt",
  "record-attempt-failure",
  "record-user-input",
  "record-validation",
  "resolve-scope-decision",
  "start-session",
]);
const ROLES = new Set([
  "documentador",
  "evaluador",
  "explorador",
  "implementador",
  "planificador",
  "tester",
]);
const WORKFLOWS = new Set(["architecture", "bugfix", "feature", "refactor"]);
const WRITER_ROLES = new Set(["documentador", "implementador", "tester"]);
const WRITER_TERMINAL_COMMANDS = new Set(["accept-role-report", "record-attempt-failure"]);
const WRITER_TERMINAL_STATES = new Set(["completed", "failed"]);
const EVALUATION_RISKS = new Set([
  "architectural-decision",
  "considerable-fan-in",
  "public-compatibility-or-migration",
  "security-or-integrity",
]);
const FINDING_CLASSIFICATIONS = new Set([
  "acceptance_violation",
  "informational",
  "novel_adversarial_finding",
  "transversal_policy_violation",
]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const RETRY_CAUSES = new Set(["evaluation-rework", "interruption", "stale-read", "timeout"]);
const COMMAND_PAYLOAD_KEYS = {
  "accept-plan": new Set([
    "acceptanceContract",
    "documentationReason",
    "documentationRequired",
    "evaluationRisk",
    "evaluationStrategy",
    "workUnits",
  ]),
  "accept-role-report": new Set(["attemptId", "report"]),
  "amend-scope": new Set(["acceptanceContract", "additionalReworkCycles", "approvalReference"]),
  "close-session": new Set(),
  "dispatch-attempt": new Set([
    "attemptId",
    "contextManifest",
    "elevation",
    "evaluationAxis",
    "findings",
    "laneId",
    "objective",
    "phase",
    "retryCause",
    "role",
    "rules",
    "tasks",
    "workUnitId",
  ]),
  "record-attempt-failure": new Set(["attemptId", "reason", "retryCause"]),
  "record-user-input": new Set(["reference"]),
  "record-validation": new Set(["evidence"]),
  "resolve-scope-decision": new Set(["action", "reference"]),
  "start-session": new Set([
    "contextBudgetBytes",
    "evaluationRisk",
    "evaluationStrategy",
    "lightStrategy",
    "mode",
    "requirements",
    "workflow",
  ]),
};

function sameWriterOwner(left, right) {
  return Boolean(
    left &&
      right &&
      left.attempt === right.attempt &&
      left.session === right.session &&
      left.workingTreeId === right.workingTreeId,
  );
}

async function writerOwner(stateStore, session, attempt) {
  return {
    attempt,
    session,
    workingTreeId: await stateStore.workingTreeId(),
  };
}

function terminalWriterAttempt(state, command) {
  if (!WRITER_TERMINAL_COMMANDS.has(command.type)) return undefined;
  const attempt = state.attempts?.[command.payload?.attemptId];
  if (attempt?.permission !== "writer" || !WRITER_TERMINAL_STATES.has(attempt.state)) {
    return undefined;
  }
  return attempt;
}

function assertExactKeys(value, allowed, label, code) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    invalid(code, `${label} contiene campos no admitidos: ${unexpected.join(", ")}.`);
  }
}

function assertStringArray(value, label, code) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(code, `${label} debe ser una lista de strings.`);
  }
}

function assertDigest(value, label, code) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    invalid(code, `${label} debe ser un digest sha256 canónico.`);
  }
}

function containsReference(value, target, seen = new Set()) {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return false;
  if (value === target) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((nested) => containsReference(nested, target, seen));
}

function validateCommandPayload(command) {
  assertExactKeys(
    command.payload ?? {},
    COMMAND_PAYLOAD_KEYS[command.type],
    `${command.type}.payload`,
    "invalid_command",
  );
  if (command.type === "start-session") {
    validateRequirements(command.payload?.requirements);
  }
}

function recoverableBootstrapCommand(command) {
  return {
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
    payload: clone(command.payload ?? {}),
    schemaVersion: command.schemaVersion,
    sessionId: command.sessionId,
    type: command.type,
  };
}

function invalid(code, message, details) {
  throw new KernelError(code, message, details);
}

function expectedAxes(state) {
  return state.evaluationStrategy === "dual" ? ["standards", "specification"] : ["combined"];
}

function isCompact(state) {
  return state.mode === "light" && state.lightStrategy === "compact";
}

function normalizeMode(payload) {
  if (!new Set(["full", "light"]).has(payload.mode)) {
    invalid("invalid_command", "mode debe ser full o light.");
  }
  if (payload.mode === "full") {
    if (Object.hasOwn(payload, "lightStrategy")) {
      invalid("invalid_command", "lightStrategy solo aplica a mode=light.");
    }
    return { lightStrategy: undefined, mode: "full" };
  }
  const lightStrategy = payload.lightStrategy ?? "compact";
  if (lightStrategy !== "compact") {
    invalid("invalid_command", "lightStrategy debe ser compact.");
  }
  return { lightStrategy, mode: "light" };
}

function validateEvaluationStrategy(strategy, risk) {
  if (!new Set(["combined", "dual"]).has(strategy)) {
    invalid("invalid_plan", "evaluationStrategy debe ser combined o dual.");
  }
  if (risk !== undefined && !EVALUATION_RISKS.has(risk)) {
    invalid("invalid_plan", "evaluationRisk no pertenece a la lista cerrada admitida.");
  }
  if (strategy === "dual" && !EVALUATION_RISKS.has(risk)) {
    invalid("invalid_plan", "La evaluación dual exige un evaluationRisk admitido.");
  }
}

function validateAcceptanceContract(input) {
  assertRecord(input, "AcceptanceContract", "invalid_acceptance_contract");
  assertExactKeys(
    input,
    new Set([
      "approval",
      "contractId",
      "criteria",
      "destructive",
      "hash",
      "nonGoals",
      "riskClass",
      "schemaVersion",
      "threatModel",
      "transversalPolicies",
      "userIntent",
      "version",
    ]),
    "AcceptanceContract",
    "invalid_acceptance_contract",
  );
  if (input.schemaVersion !== SCHEMA_VERSION) {
    invalid("invalid_acceptance_contract", "AcceptanceContract debe usar schemaVersion 2.");
  }
  if (Object.hasOwn(input, "destructive") && typeof input.destructive !== "boolean") {
    invalid("invalid_acceptance_contract", "destructive debe ser booleano.");
  }
  assertNonEmptyString(input.contractId, "contractId", "invalid_acceptance_contract");
  if (!Number.isInteger(input.version) || input.version < 1) {
    invalid("invalid_acceptance_contract", "La versión del contrato debe ser positiva.");
  }
  assertNonEmptyString(input.userIntent, "userIntent", "invalid_acceptance_contract");
  assertNonEmptyString(input.riskClass, "riskClass", "invalid_acceptance_contract");
  assertStringArray(input.nonGoals, "nonGoals", "invalid_acceptance_contract");
  if (!Array.isArray(input.criteria) || !input.criteria.length) {
    invalid("invalid_acceptance_contract", "El contrato debe declarar criterios.");
  }
  const criterionIds = new Set();
  for (const criterion of input.criteria) {
    assertRecord(criterion, "criterion", "invalid_acceptance_contract");
    assertExactKeys(
      criterion,
      new Set(["id", "oracle", "statement"]),
      "criterion",
      "invalid_acceptance_contract",
    );
    for (const field of ["id", "statement", "oracle"]) {
      assertNonEmptyString(criterion[field], `criterion.${field}`, "invalid_acceptance_contract");
    }
    if (criterionIds.has(criterion.id)) {
      invalid("invalid_acceptance_contract", `Criterio duplicado: ${criterion.id}.`);
    }
    criterionIds.add(criterion.id);
  }
  if (!Array.isArray(input.transversalPolicies)) {
    invalid("invalid_acceptance_contract", "transversalPolicies debe ser una lista.");
  }
  const policyIds = new Set();
  for (const policy of input.transversalPolicies) {
    assertRecord(policy, "policy", "invalid_acceptance_contract");
    assertExactKeys(
      policy,
      new Set(["id", "version"]),
      "policy",
      "invalid_acceptance_contract",
    );
    assertNonEmptyString(policy.id, "policy.id", "invalid_acceptance_contract");
    assertNonEmptyString(policy.version, "policy.version", "invalid_acceptance_contract");
    if (policyIds.has(policy.id)) {
      invalid("invalid_acceptance_contract", `Política duplicada: ${policy.id}.`);
    }
    policyIds.add(policy.id);
  }
  assertRecord(input.threatModel, "threatModel", "invalid_acceptance_contract");
  assertExactKeys(
    input.threatModel,
    new Set([
      "commitPoints",
      "enumeratedFaults",
      "excludedFaults",
      "postCommitFailureSemantics",
      "preCommitFailureSemantics",
    ]),
    "threatModel",
    "invalid_acceptance_contract",
  );
  for (const field of ["commitPoints", "enumeratedFaults", "excludedFaults"]) {
    assertStringArray(input.threatModel[field], `threatModel.${field}`, "invalid_acceptance_contract");
  }
  for (const field of ["preCommitFailureSemantics", "postCommitFailureSemantics"]) {
    if (Object.hasOwn(input.threatModel, field) && typeof input.threatModel[field] !== "string") {
      invalid("invalid_acceptance_contract", `threatModel.${field} debe ser string.`);
    }
  }
  assertRecord(input.approval, "approval", "invalid_acceptance_contract");
  assertExactKeys(
    input.approval,
    new Set(["kind", "reference"]),
    "approval",
    "invalid_acceptance_contract",
  );
  assertNonEmptyString(input.approval.kind, "approval.kind", "invalid_acceptance_contract");
  assertNonEmptyString(input.approval.reference, "approval.reference", "invalid_acceptance_contract");
  const expectedHash = acceptanceContractHash(input);
  if (input.hash !== expectedHash) {
    invalid("invalid_acceptance_contract", "El hash del contrato no coincide con su contenido.", {
      actual: input.hash,
      expected: expectedHash,
    });
  }
  return clone(input);
}

function destructiveContractGaps(contract) {
  if (!contract.destructive) return [];
  const threat = contract.threatModel ?? {};
  const gaps = [];
  if (!Array.isArray(threat.commitPoints) || !threat.commitPoints.length) gaps.push("commitPoints");
  if (typeof threat.preCommitFailureSemantics !== "string" || !threat.preCommitFailureSemantics.trim()) {
    gaps.push("preCommitFailureSemantics");
  }
  if (typeof threat.postCommitFailureSemantics !== "string" || !threat.postCommitFailureSemantics.trim()) {
    gaps.push("postCommitFailureSemantics");
  }
  return gaps;
}

function assertScopeExtension(previous, next) {
  if (next.userIntent !== previous.userIntent) {
    invalid("invalid_scope_amendment", "Una ampliación no puede reescribir la intención aprobada.");
  }
  for (const nonGoal of previous.nonGoals) {
    if (!next.nonGoals.includes(nonGoal)) {
      invalid("invalid_scope_amendment", `La ampliación eliminó el non-goal vigente: ${nonGoal}.`);
    }
  }
  if (next.riskClass !== previous.riskClass) {
    invalid("invalid_scope_amendment", "Una ampliación no puede reclasificar el riesgo vigente.");
  }
  const nextCriteria = new Map(next.criteria.map((criterion) => [criterion.id, criterion]));
  for (const criterion of previous.criteria) {
    const candidate = nextCriteria.get(criterion.id);
    if (
      !candidate ||
      candidate.statement !== criterion.statement ||
      candidate.oracle !== criterion.oracle
    ) {
      invalid(
        "invalid_scope_amendment",
        `La ampliación alteró o retiró el criterio vigente ${criterion.id}.`,
      );
    }
  }
  const nextPolicies = new Map(next.transversalPolicies.map((policy) => [policy.id, policy.version]));
  for (const policy of previous.transversalPolicies) {
    if (nextPolicies.get(policy.id) !== policy.version) {
      invalid(
        "invalid_scope_amendment",
        `La ampliación alteró o retiró la política vigente ${policy.id}@${policy.version}.`,
      );
    }
  }
  if (previous.destructive && !next.destructive) {
    invalid("invalid_scope_amendment", "Una ampliación no puede retirar la marca destructiva.");
  }
  for (const field of ["commitPoints", "enumeratedFaults"]) {
    for (const entry of previous.threatModel[field]) {
      if (!next.threatModel[field].includes(entry)) {
        invalid(
          "invalid_scope_amendment",
          `La ampliación retiró threatModel.${field}: ${entry}.`,
        );
      }
    }
  }
  for (const excludedFault of next.threatModel.excludedFaults) {
    if (!previous.threatModel.excludedFaults.includes(excludedFault)) {
      invalid(
        "invalid_scope_amendment",
        `La ampliación agregó un fallo excluido: ${excludedFault}.`,
      );
    }
  }
  for (const field of ["preCommitFailureSemantics", "postCommitFailureSemantics"]) {
    if (previous.threatModel[field] && next.threatModel[field] !== previous.threatModel[field]) {
      invalid("invalid_scope_amendment", `La ampliación alteró threatModel.${field}.`);
    }
  }
  const expanded =
    next.criteria.length > previous.criteria.length ||
    next.transversalPolicies.length > previous.transversalPolicies.length ||
    next.threatModel.commitPoints.length > previous.threatModel.commitPoints.length ||
    next.threatModel.enumeratedFaults.length > previous.threatModel.enumeratedFaults.length ||
    next.threatModel.excludedFaults.length < previous.threatModel.excludedFaults.length ||
    (!previous.threatModel.preCommitFailureSemantics &&
      Boolean(next.threatModel.preCommitFailureSemantics)) ||
    (!previous.threatModel.postCommitFailureSemantics &&
      Boolean(next.threatModel.postCommitFailureSemantics)) ||
    next.destructive !== previous.destructive;
  if (!expanded) {
    invalid("invalid_scope_amendment", "La nueva versión no amplía el alcance estructurado.");
  }
}

function canonicalOwnedPath(path) {
  assertNonEmptyString(path, "ownedPath", "invalid_plan");
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment !== segment.replace(/[. ]+$/g, ""),
    )
  ) {
    invalid("invalid_plan", `Ruta de ownership insegura o no portable: ${path}.`);
  }
  return normalized;
}

function normalizeWorkUnits(input, contract, { allowEmpty = false } = {}) {
  if (!Array.isArray(input) || input.length > 3 || (!allowEmpty && !input.length)) {
    invalid("invalid_plan", "workUnits debe contener entre una y tres unidades.");
  }
  const contractCriteria = new Set(contract.criteria.map((criterion) => criterion.id));
  const units = {};
  const ownedPaths = new Map();
  for (const unit of input) {
    assertRecord(unit, "workUnit", "invalid_plan");
    assertExactKeys(
      unit,
      new Set(["criterionIds", "dependsOn", "ownedPaths", "workUnitId"]),
      "workUnit",
      "invalid_plan",
    );
    assertNonEmptyString(unit.workUnitId, "workUnitId", "invalid_plan");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(unit.workUnitId) || unit.workUnitId.length > 63) {
      invalid("invalid_plan", `workUnitId inseguro: ${unit.workUnitId}.`);
    }
    if (Object.hasOwn(units, unit.workUnitId)) {
      invalid("invalid_plan", `Unidad duplicada: ${unit.workUnitId}.`);
    }
    if (!Array.isArray(unit.criterionIds) || !unit.criterionIds.length) {
      invalid("invalid_plan", `${unit.workUnitId} no declara criterionIds.`);
    }
    for (const criterionId of unit.criterionIds) {
      if (!contractCriteria.has(criterionId)) {
        invalid("invalid_plan", `${unit.workUnitId} cita un criterio inexistente: ${criterionId}.`);
      }
    }
    if (!Array.isArray(unit.ownedPaths) || !unit.ownedPaths.length) {
      invalid("invalid_plan", `${unit.workUnitId} no declara ownedPaths.`);
    }
    const normalizedOwnedPaths = [];
    for (const candidate of unit.ownedPaths) {
      const path = canonicalOwnedPath(candidate);
      const portable = path.toLowerCase();
      const overlap = [...ownedPaths.keys()].find(
        (existing) =>
          existing === portable ||
          existing.startsWith(`${portable}/`) ||
          portable.startsWith(`${existing}/`),
      );
      if (overlap) {
        invalid(
          "invalid_plan",
          `Ownership solapado entre ${ownedPaths.get(overlap)} y ${unit.workUnitId}: ${path}.`,
        );
      }
      ownedPaths.set(portable, unit.workUnitId);
      normalizedOwnedPaths.push(path);
    }
    if (!Array.isArray(unit.dependsOn)) {
      invalid("invalid_plan", `${unit.workUnitId}.dependsOn debe ser una lista.`);
    }
    if (new Set(unit.dependsOn).size !== unit.dependsOn.length) {
      invalid("invalid_plan", `${unit.workUnitId} contiene dependencias duplicadas.`);
    }
    units[unit.workUnitId] = {
      consolidated: false,
      criterionIds: [...unit.criterionIds],
      dependsOn: [...unit.dependsOn],
      ownedPaths: normalizedOwnedPaths,
      status: "pending",
      validated: false,
    };
  }
  for (const unit of Object.values(units)) {
    for (const dependency of unit.dependsOn) {
      if (!Object.hasOwn(units, dependency)) {
        invalid("invalid_plan", `Dependencia inexistente: ${dependency}.`);
      }
    }
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(workUnitId) {
    if (visiting.has(workUnitId)) invalid("invalid_plan", "El DAG de unidades contiene un ciclo.");
    if (visited.has(workUnitId)) return;
    visiting.add(workUnitId);
    for (const dependency of units[workUnitId].dependsOn) visit(dependency);
    visiting.delete(workUnitId);
    visited.add(workUnitId);
  }
  for (const workUnitId of Object.keys(units)) visit(workUnitId);
  return units;
}

function allUnitsConsolidated(state) {
  const units = Object.values(state.workUnits);
  return Boolean(units.length) && units.every((unit) => unit.consolidated && unit.validated);
}

function canonicalContextPath(path) {
  assertNonEmptyString(path, "contextManifest.path", "invalid_context_manifest");
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized
      .split("/")
      .some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment !== segment.replace(/[. ]+$/g, ""),
      )
  ) {
    invalid("invalid_context_manifest", `Ruta de contexto insegura: ${path}.`);
  }
  if (/^(?:\.codegraph|\.engram|\.git|node_modules|\.agents\/sessions)(?:\/|$)/i.test(normalized)) {
    invalid("invalid_context_manifest", `Ruta de contexto protegida: ${path}.`);
  }
  return normalized;
}

function normalizeContextManifest(input, budget) {
  if (!Array.isArray(input)) invalid("invalid_context_manifest", "contextManifest debe ser una lista.");
  const entries = [];
  const seen = new Map();
  for (const candidate of input) {
    assertRecord(candidate, "contextManifest entry", "invalid_context_manifest");
    assertExactKeys(
      candidate,
      new Set(["bytes", "hash", "path"]),
      "contextManifest entry",
      "invalid_context_manifest",
    );
    const path = canonicalContextPath(candidate.path);
    assertDigest(candidate.hash, "contextManifest.hash", "invalid_context_manifest");
    if (!Number.isInteger(candidate.bytes) || candidate.bytes < 0) {
      invalid("invalid_context_manifest", "contextManifest.bytes debe ser un entero no negativo.");
    }
    const portable = path
      .split("/")
      .map((segment) => segment.replace(/[. ]+$/g, "").toLowerCase())
      .join("/");
    if (seen.has(portable)) {
      const previous = seen.get(portable);
      if (previous.hash !== candidate.hash || previous.bytes !== candidate.bytes) {
        invalid("context_conflict", `La ruta ${path} aparece con metadatos distintos.`);
      }
      continue;
    }
    const entry = { bytes: candidate.bytes, hash: candidate.hash, path };
    seen.set(portable, entry);
    entries.push(entry);
  }
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (bytes > budget) {
    invalid("context_budget_exceeded", `El manifiesto usa ${bytes} bytes y el máximo es ${budget}.`, {
      actualBytes: bytes,
      maximumBytes: budget,
    });
  }
  return { bytes, entries };
}

function validateFinding(input, state) {
  assertRecord(input, "finding", "invalid_role_report");
  assertExactKeys(
    input,
    new Set([
      "classification",
      "criterionIds",
      "findingId",
      "policyIds",
      "reproduction",
      "severity",
      "summary",
    ]),
    "finding",
    "invalid_role_report",
  );
  assertOpaqueIdentifier(input.findingId, "findingId", "invalid_role_report");
  if (!FINDING_CLASSIFICATIONS.has(input.classification)) {
    invalid("invalid_role_report", `Clasificación inválida: ${input.classification}.`);
  }
  if (!SEVERITIES.has(input.severity)) invalid("invalid_role_report", "Severidad inválida.");
  assertNonEmptyString(input.summary, "finding.summary", "invalid_role_report");
  assertStringArray(input.criterionIds, "finding.criterionIds", "invalid_role_report");
  assertStringArray(input.policyIds, "finding.policyIds", "invalid_role_report");
  const criterionIds = [...input.criterionIds].sort();
  const policyIds = [...input.policyIds].sort();
  if (new Set(criterionIds).size !== criterionIds.length || new Set(policyIds).size !== policyIds.length) {
    invalid("invalid_role_report", "criterionIds y policyIds no admiten duplicados.");
  }
  const validCriteria = new Set(
    (state.acceptanceContract?.criteria ?? []).map((criterion) => criterion.id),
  );
  const validPolicies = new Set(
    (state.acceptanceContract?.transversalPolicies ?? []).map((policy) => policy.id),
  );
  for (const id of criterionIds) {
    if (!validCriteria.has(id)) invalid("invalid_role_report", `Criterio inexistente: ${id}.`);
  }
  for (const id of policyIds) {
    if (!validPolicies.has(id)) invalid("invalid_role_report", `Política inexistente: ${id}.`);
  }
  if (input.classification === "acceptance_violation" && !criterionIds.length) {
    invalid("invalid_role_report", "acceptance_violation exige criterionIds vigentes.");
  }
  if (input.classification === "transversal_policy_violation" && !policyIds.length) {
    invalid("invalid_role_report", "transversal_policy_violation exige policyIds vigentes.");
  }
  if (
    input.classification === "novel_adversarial_finding" &&
    (criterionIds.length || policyIds.length)
  ) {
    invalid("invalid_role_report", "Un finding nuevo no puede citar aceptación vigente.");
  }
  if (input.classification !== "informational" || Object.hasOwn(input, "reproduction")) {
    assertRecord(input.reproduction, "finding.reproduction", "invalid_role_report");
    assertExactKeys(
      input.reproduction,
      new Set(["commandDigest", "expected", "observed"]),
      "finding.reproduction",
      "invalid_role_report",
    );
    for (const field of ["commandDigest", "expected", "observed"]) {
      if (field === "commandDigest") {
        assertDigest(input.reproduction[field], `finding.reproduction.${field}`, "invalid_role_report");
      } else {
        assertNonEmptyString(
          input.reproduction[field],
          `finding.reproduction.${field}`,
          "invalid_role_report",
        );
      }
    }
  }
  const normalized = {
    classification: input.classification,
    criterionIds,
    findingId: input.findingId,
    policyIds,
    reproduction: clone(input.reproduction ?? {}),
    severity: input.severity,
    summary: input.summary,
  };
  normalized.fingerprint = digestObject({
    classification: normalized.classification,
    criterionIds: normalized.criterionIds,
    policyIds: normalized.policyIds,
    reproduction: normalized.reproduction,
    severity: normalized.severity,
  });
  return normalized;
}

function validateRoleReport(report, state, attempt) {
  assertRecord(report, "RoleReport", "invalid_role_report");
  assertExactKeys(
    report,
    new Set([
      "acceptanceContractHash",
      "attemptId",
      "completion",
      "decision",
      "evidence",
      "findings",
      "humanSummary",
      "role",
      "schemaVersion",
      "sessionId",
    ]),
    "RoleReport",
    "invalid_role_report",
  );
  if (report.schemaVersion !== SCHEMA_VERSION) {
    invalid("invalid_role_report", "RoleReport debe usar schemaVersion 2.");
  }
  if (report.sessionId !== state.sessionId || report.attemptId !== attempt.attemptId) {
    invalid("invalid_role_report", "El reporte no pertenece al intento activo.");
  }
  if (report.role !== attempt.role) invalid("invalid_role_report", "El rol del reporte no coincide.");
  if (report.acceptanceContractHash !== attempt.contractHash) {
    invalid("acceptance_contract_mismatch", "El reporte no usa el hash contractual del intento.");
  }
  if (!new Set(["completed", "needs_input"]).has(report.completion)) {
    invalid("invalid_role_report", "completion debe ser completed o needs_input.");
  }
  if (!new Set(["fail", "pass"]).has(report.decision)) {
    invalid("invalid_role_report", "decision debe ser pass o fail.");
  }
  if (!Array.isArray(report.findings) || !Array.isArray(report.evidence)) {
    invalid("invalid_role_report", "findings y evidence deben ser listas.");
  }
  for (const evidence of report.evidence) {
    assertRecord(evidence, "RoleReport.evidence", "invalid_role_report");
    assertExactKeys(
      evidence,
      new Set(["commandDigest", "durationMs", "exitCode", "kind"]),
      "RoleReport.evidence",
      "invalid_role_report",
    );
    if (evidence.kind !== "command") {
      invalid("invalid_role_report", "RoleReport.evidence solo admite evidencia kind=command.");
    }
    assertDigest(evidence.commandDigest, "RoleReport.evidence.commandDigest", "invalid_role_report");
    if (
      !Number.isInteger(evidence.exitCode) ||
      evidence.exitCode < 0 ||
      !Number.isFinite(evidence.durationMs) ||
      evidence.durationMs < 0
    ) {
      invalid("invalid_role_report", "La evidencia de comando contiene exitCode o durationMs inválidos.");
    }
  }
  if (
    report.decision === "pass" &&
    report.evidence.some((evidence) => evidence.kind === "command" && evidence.exitCode !== 0)
  ) {
    invalid("invalid_role_report", "decision=pass contradice una evidencia de comando roja.");
  }
  if (
    attempt.role === "evaluador" &&
    isCompact(state) &&
    report.completion === "completed" &&
    !report.evidence.some((evidence) => evidence.kind === "command")
  ) {
    invalid("invalid_role_report", "El Evaluador compacto exige evidencia de comando independiente.");
  }
  assertNonEmptyString(report.humanSummary, "humanSummary", "invalid_role_report");
  const findings = report.findings.map((finding) => validateFinding(finding, state));
  const violations = findings.filter((finding) =>
    ["acceptance_violation", "transversal_policy_violation"].includes(finding.classification),
  );
  if (report.decision === "pass" && violations.length) {
    invalid("invalid_role_report", "decision=pass contradice una violación estructurada.");
  }
  if (report.decision === "fail" && !findings.some((finding) => finding.classification !== "informational")) {
    invalid("invalid_role_report", "decision=fail exige al menos un finding accionable.");
  }
  return { ...clone(report), findings };
}

function validateValidationEvidence(evidence, state) {
  assertRecord(evidence, "ValidationEvidence", "invalid_validation_evidence");
  assertExactKeys(
    evidence,
    new Set([
      "commands",
      "decision",
      "environmentFingerprint",
      "generation",
      "laneId",
      "schemaVersion",
      "treeFingerprint",
    ]),
    "ValidationEvidence",
    "invalid_validation_evidence",
  );
  if (evidence.schemaVersion !== SCHEMA_VERSION) {
    invalid("invalid_validation_evidence", "ValidationEvidence debe usar schemaVersion 2.");
  }
  const laneId = `full:${state.generation}`;
  if (evidence.laneId !== laneId || evidence.generation !== state.generation) {
    invalid("invalid_validation_evidence", `La evidencia debe pertenecer a ${laneId}.`);
  }
  for (const field of ["treeFingerprint", "environmentFingerprint"]) {
    assertDigest(evidence[field], field, "invalid_validation_evidence");
  }
  if (!Array.isArray(evidence.commands) || !evidence.commands.length) {
    invalid("invalid_validation_evidence", "La evidencia debe declarar comandos.");
  }
  for (const command of evidence.commands) {
    assertRecord(command, "validation command", "invalid_validation_evidence");
    assertExactKeys(
      command,
      new Set(["digest", "durationMs", "exitCode"]),
      "validation command",
      "invalid_validation_evidence",
    );
    assertDigest(command.digest, "command.digest", "invalid_validation_evidence");
    if (!Number.isInteger(command.exitCode) || command.exitCode < 0) {
      invalid("invalid_validation_evidence", "command.exitCode debe ser no negativo.");
    }
    if (!Number.isFinite(command.durationMs) || command.durationMs < 0) {
      invalid("invalid_validation_evidence", "command.durationMs debe ser no negativo.");
    }
  }
  if (!new Set(["fail", "pass"]).has(evidence.decision)) {
    invalid("invalid_validation_evidence", "decision debe ser pass o fail.");
  }
  const failedCommands = evidence.commands.filter((command) => command.exitCode !== 0);
  if (
    (evidence.decision === "pass" && failedCommands.length) ||
    (evidence.decision === "fail" && !failedCommands.length)
  ) {
    invalid(
      "invalid_validation_evidence",
      "decision contradice los códigos de salida de los comandos de validación.",
    );
  }
  return { ...clone(evidence), fingerprint: validationFingerprint(evidence) };
}

function mergeFinding(state, finding, attemptId) {
  const existing = state.findings[finding.fingerprint];
  if (existing) {
    if (!existing.sources.includes(attemptId)) existing.sources.push(attemptId);
    existing.lastSeenGeneration = state.generation;
    if (
      existing.status === "resolved" &&
      ["acceptance_violation", "transversal_policy_violation"].includes(
        existing.classification,
      )
    ) {
      existing.reopenedGenerations ??= [];
      if (!existing.reopenedGenerations.includes(state.generation)) {
        existing.reopenedGenerations.push(state.generation);
      }
      delete existing.resolvedGeneration;
      existing.status = "open";
    }
    return;
  }
  state.findings[finding.fingerprint] = {
    ...clone(finding),
    firstSeenGeneration: state.generation,
    lastSeenGeneration: state.generation,
    sources: [attemptId],
    status: "open",
  };
}

function completeAttempt(attempt, report, clock) {
  attempt.closedAt = clock.nowUtc();
  attempt.closedMonotonic = clock.nowMonotonic();
  attempt.durationMs = Math.max(0, attempt.closedMonotonic - attempt.openedMonotonic);
  attempt.report = clone(report);
  attempt.state = "completed";
}

function failAttempt(attempt, payload, clock) {
  assertNonEmptyString(payload.reason, "reason");
  if (!RETRY_CAUSES.has(payload.retryCause)) {
    invalid("invalid_command", "record-attempt-failure exige una retryCause admitida.");
  }
  attempt.closedAt = clock.nowUtc();
  attempt.closedMonotonic = clock.nowMonotonic();
  attempt.durationMs = Math.max(0, attempt.closedMonotonic - attempt.openedMonotonic);
  attempt.failure = { reason: payload.reason, retryCause: payload.retryCause };
  attempt.state = "failed";
}

function invalidateForRework(state, reason) {
  state.generation += 1;
  state.reworkCause = reason;
  state.lifecycle = "executing";
  for (const unit of Object.values(state.workUnits)) {
    unit.consolidated = false;
    unit.status = "needs_rework";
    unit.validated = false;
  }
  state.validations = {};
}

function validateCompactUnit(state) {
  if (!isCompact(state)) return;
  const [unit] = Object.values(state.workUnits);
  unit.consolidated = true;
  unit.status = "validated";
  unit.validated = true;
}

function finishEvaluation(state) {
  const evaluation = state.evaluations[String(state.generation)];
  const reports = Object.values(evaluation.axes);
  const findings = reports.flatMap((axis) => axis.findings);
  const blocking = findings.filter((finding) =>
    ["acceptance_violation", "transversal_policy_violation"].includes(finding.classification),
  );
  const criticalNovel = findings.filter(
    (finding) =>
      finding.classification === "novel_adversarial_finding" && finding.severity === "critical",
  );
  if (criticalNovel.length) {
    if (!blocking.length) validateCompactUnit(state);
    state.lifecycle = "scope_decision_required";
    state.scopeDecision = {
      findingFingerprints: criticalNovel.map((finding) => finding.fingerprint),
      blockingFindingFingerprints: blocking.map((finding) => finding.fingerprint),
      options: ["amend", "defer", "accept-risk", "cancel"],
      reason: "novel_adversarial_finding",
    };
    return { decision: "scope_decision_required", reason: "novel_adversarial_finding" };
  }
  const deferred = findings.filter(
    (finding) =>
      finding.classification === "novel_adversarial_finding" && finding.severity !== "critical",
  );
  for (const finding of deferred) {
    if (!state.deferredFindings.includes(finding.fingerprint)) {
      state.deferredFindings.push(finding.fingerprint);
    }
    if (state.findings[finding.fingerprint]) {
      state.findings[finding.fingerprint].status = "deferred";
    }
  }
  if (blocking.length) {
    if (state.evaluationReworkCycles >= state.maxEvaluationReworkCycles) {
      state.lifecycle = "scope_decision_required";
      state.scopeDecision = {
        findingFingerprints: blocking.map((finding) => finding.fingerprint),
        options: ["amend", "defer", "accept-risk", "cancel"],
        reason: "rework_budget_exhausted",
      };
      return { decision: "scope_decision_required", reason: "rework_budget_exhausted" };
    }
    state.evaluationReworkCycles += 1;
    invalidateForRework(state, "evaluation_rejected");
    return { decision: "changes_required", evaluationReworkCycle: state.evaluationReworkCycles };
  }
  validateCompactUnit(state);
  for (const storedFinding of Object.values(state.findings)) {
    if (
      storedFinding.status === "open" &&
      storedFinding.firstSeenGeneration < state.generation &&
      ["acceptance_violation", "transversal_policy_violation"].includes(
        storedFinding.classification,
      )
    ) {
      storedFinding.resolvedGeneration = state.generation;
      storedFinding.status = "resolved";
    }
  }
  evaluation.decision = "pass";
  if (state.documentationRequired) {
    state.lifecycle = "documenting";
  } else {
    state.documentation = { decision: "not_applicable", reason: state.documentationReason };
    state.lifecycle = "completed";
  }
  return { decision: "pass" };
}

function makeEnvelope(state, payload, manifest) {
  const contractHash = state.acceptanceContractHash ?? state.planningScopeHash;
  return deepFreeze({
    acceptanceContractHash: contractHash,
    contractKind: state.acceptanceContractHash ? "acceptance" : "planning-scope",
    contextManifest: manifest.entries,
    contextPaths: manifest.entries.map((entry) => entry.path),
    findings: clone(payload.findings ?? []),
    generation: state.generation,
    objective: payload.objective,
    role: payload.role,
    rules: payload.rules,
    schemaVersion: SCHEMA_VERSION,
    sessionId: state.sessionId,
    sourceRevision: state.revision,
    tasks: payload.tasks,
    ...(payload.attemptId ? { attemptId: payload.attemptId } : {}),
    ...(payload.evaluationAxis ? { evaluationAxis: payload.evaluationAxis } : {}),
    ...(payload.laneId ? { laneId: payload.laneId } : {}),
    ...(payload.phase ? { phase: payload.phase } : {}),
    ...(payload.workUnitId ? { workUnitId: payload.workUnitId } : {}),
  });
}

function protectWorkEnvelope(result) {
  if (result?.envelope) deepFreeze(result.envelope);
  return result;
}

function validateRequirements(requirements) {
  if (requirements) {
    assertRecord(requirements, "requirements");
    assertExactKeys(
      requirements,
      new Set(["browser", "commands", "network"]),
      "requirements",
      "invalid_command",
    );
    if (
      Object.hasOwn(requirements, "commands") &&
      (!Array.isArray(requirements.commands) ||
        requirements.commands.some(
          (commandName) => typeof commandName !== "string" || !commandName.trim(),
        ))
    ) {
      invalid("invalid_command", "requirements.commands debe ser una lista de ejecutables.");
    }
    for (const capability of ["browser", "network"]) {
      if (
        Object.hasOwn(requirements, capability) &&
        typeof requirements[capability] !== "boolean"
      ) {
        invalid("invalid_command", `requirements.${capability} debe ser booleano.`);
      }
    }
  }
}

function normalizeStartConfiguration(payload, configuration) {
  const mode = normalizeMode(payload);
  const evaluationStrategy = payload.evaluationStrategy ?? "combined";
  validateEvaluationStrategy(evaluationStrategy, payload.evaluationRisk);
  if (!WORKFLOWS.has(payload.workflow)) {
    invalid("invalid_command", "start-session exige un workflow canónico.");
  }
  if (payload.workflow === "architecture" && mode.mode === "light") {
    invalid("invalid_command", "architecture no admite light.");
  }
  const maximum = 2;
  const contextBudgetBytes = payload.contextBudgetBytes ?? configuration.contextBudgetBytes;
  if (!Number.isInteger(contextBudgetBytes) || contextBudgetBytes < 1) {
    invalid("invalid_command", "contextBudgetBytes debe ser positivo.");
  }
  return { contextBudgetBytes, evaluationStrategy, maximum, mode };
}

function startState(command, environmentReport, clock, configuration, normalizedConfiguration) {
  const payload = command.payload ?? {};
  const {
    contextBudgetBytes,
    evaluationStrategy,
    maximum,
    mode,
  } = normalizedConfiguration ?? normalizeStartConfiguration(payload, configuration);
  const nowUtc = clock.nowUtc();
  const nowMonotonic = clock.nowMonotonic();
  const planningScopeHash = digestObject({
    evaluationStrategy,
    lightStrategy: mode.lightStrategy,
    mode: mode.mode,
    schemaVersion: SCHEMA_VERSION,
    sessionId: command.sessionId,
    workflow: payload.workflow,
  });
  return {
    acceptanceContract: undefined,
    acceptanceContractHash: undefined,
    closed: false,
    commands: {},
    contextBudgetBytes,
    deferredFindings: [],
    documentationRequired: true,
    environment: clone(environmentReport),
    evaluationReworkCycles: 0,
    evaluationRisk: payload.evaluationRisk,
    evaluationStrategy,
    evaluations: {},
    findings: {},
    generation: 1,
    lifecycle: "planning",
    maxEvaluationReworkCycles: maximum,
    ...mode,
    openedAt: nowUtc,
    openedMonotonic: nowMonotonic,
    planningScopeHash,
    recovery: { bootstrapCommand: recoverableBootstrapCommand(command) },
    revision: 0,
    schemaVersion: SCHEMA_VERSION,
    sessionId: command.sessionId,
    stateEnteredAt: nowUtc,
    stateEnteredMonotonic: nowMonotonic,
    telemetry: { degradedEvents: [], pendingEvents: {} },
    attempts: {},
    validations: {},
    workflow: payload.workflow,
    workUnits: {},
  };
}

function sessionView(state) {
  const view = clone(state);
  delete view.commands;
  delete view.openedMonotonic;
  delete view.stateEnteredMonotonic;
  for (const attempt of Object.values(view.attempts ?? {})) {
    delete attempt.openedMonotonic;
    delete attempt.closedMonotonic;
  }
  return view;
}

function validateSnapshot(state, sessionId) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    state.schemaVersion !== SCHEMA_VERSION ||
    state.sessionId !== sessionId ||
    !Number.isInteger(state.revision) ||
    state.revision < 1 ||
    typeof state.lifecycle !== "string" ||
    !state.commands ||
    typeof state.commands !== "object" ||
    !state.attempts ||
    typeof state.attempts !== "object" ||
    !state.telemetry ||
    !Array.isArray(state.telemetry.degradedEvents) ||
    !state.telemetry.pendingEvents ||
    typeof state.telemetry.pendingEvents !== "object" ||
    Array.isArray(state.telemetry.pendingEvents)
  ) {
    invalid(
      "state_protocol_mismatch",
      `El snapshot ${sessionId} no satisface la identidad estructural actual.`,
    );
  }
}

function authorizeStart(kernel, command) {
  if (command.actorCapability !== kernel.bootstrapCapability) {
    invalid("actor_not_authorized", "La capacidad no autoriza al actor para iniciar sesiones.");
  }
}

function authorizeSession(kernel, state, command) {
  if (
    !kernel.capabilityRegistry.authorize(
      state.sessionId,
      command.actorCapability,
      kernel.clock.nowMonotonic(),
    )
  ) {
    invalid("actor_not_authorized", "La capacidad no autoriza al actor para mutar esta sesión.");
  }
}

function requireRevision(command, state) {
  if (command.expectedRevision !== state.revision) {
    invalid("stale_revision", `Se esperaba la revisión ${command.expectedRevision} y la actual es ${state.revision}.`, {
      actualRevision: state.revision,
      expectedRevision: command.expectedRevision,
    });
  }
}

function telemetryData(command, transition) {
  const data = {};
  if (transition.context) {
    data.contextBytes = transition.context.bytes;
    data.contextPaths = transition.context.entries.map((entry) => entry.path);
  }
  if (transition.validation) {
    data.validationCommands = transition.validation.commands.map((entry) => ({
      digest: entry.digest,
      durationMs: entry.durationMs,
      exitCode: entry.exitCode,
    }));
  }
  if (RETRY_CAUSES.has(command.payload?.retryCause)) data.retryCause = command.payload.retryCause;
  const elevation = command.payload?.elevation;
  if (elevation && typeof elevation.durationMs === "number" && elevation.durationMs >= 0) {
    data.elevation = {
      durationMs: elevation.durationMs,
      required: Boolean(elevation.required),
      ...(Object.hasOwn(elevation, "approved")
        ? { approved: Boolean(elevation.approved) }
        : {}),
    };
  }
  return data;
}

async function deliverPendingEvents(kernel, state, commandId, result) {
  const pending = Object.values(state.telemetry.pendingEvents).filter(
    (event) => event.commandId === commandId,
  );
  if (!pending.length) return;
  for (const event of pending) {
    try {
      await kernel.eventSink.append(event);
      delete state.telemetry.pendingEvents[event.eventId];
    } catch (error) {
      if (!state.telemetry.degradedEvents.some((entry) => entry.eventId === event.eventId)) {
        state.telemetry.degradedEvents.push({
          eventId: event.eventId,
          reason: error.code ?? "event_sink_failed",
        });
      }
      result.telemetryDegraded = true;
    }
  }
  state.commands[commandId].result = clone(result);
  await kernel.stateStore.save(state.sessionId, state);
}

function applyToState(state, command, clock) {
  const payload = command.payload ?? {};
  if (state.closed) invalid("session_terminal", "La sesión ya está cerrada.");
  if (state.lifecycle === "completed" && command.type !== "close-session") {
    invalid("session_terminal", "Una sesión completed no vuelve a un estado activo.");
  }
  if (state.lifecycle === "closed_rejected" && command.type !== "close-session") {
    invalid("session_terminal", "Una sesión rechazada solo admite cierre.");
  }

  if (command.type === "accept-plan") {
    if (state.lifecycle !== "planning") invalid("invalid_transition", "accept-plan exige planning.");
    if (Object.values(state.attempts).some((attempt) => attempt.state === "active")) {
      invalid("active_attempts_pending", "No se acepta el plan con intentos de planificación activos.");
    }
    const contract = validateAcceptanceContract(payload.acceptanceContract);
    if (
      Object.hasOwn(payload, "documentationRequired") &&
      typeof payload.documentationRequired !== "boolean"
    ) {
      invalid("invalid_plan", "documentationRequired debe ser booleano.");
    }
    if (Object.hasOwn(payload, "documentationReason")) {
      assertNonEmptyString(payload.documentationReason, "documentationReason", "invalid_plan");
    }
    if (state.acceptanceContractHash && contract.hash !== state.acceptanceContractHash) {
      invalid(
        "acceptance_contract_mismatch",
        "Un plan posterior a un amendment debe reutilizar exactamente el contrato ya aprobado.",
      );
    }
    const gaps = destructiveContractGaps(contract);
    if (gaps.length) {
      state.lifecycle = "awaiting_input";
      state.pendingPlan = clone(payload);
      state.pendingInput = {
        missing: gaps,
        reason: "destructive_contract_incomplete",
        resumeLifecycle: "planning",
      };
      return { result: { decision: "needs_input", missing: gaps } };
    }
    const evaluationStrategy = payload.evaluationStrategy ?? state.evaluationStrategy;
    const evaluationRisk = payload.evaluationRisk ?? state.evaluationRisk;
    validateEvaluationStrategy(evaluationStrategy, evaluationRisk);
    state.acceptanceContract = contract;
    state.acceptanceContractHash = contract.hash;
    const architectureDecisionOnly = state.workflow === "architecture" && !payload.workUnits?.length;
    state.documentationRequired = architectureDecisionOnly || payload.documentationRequired !== false;
    state.documentationReason = payload.documentationReason ?? "Contrato o decisión durable afectada.";
    state.evaluationRisk = evaluationRisk;
    state.evaluationStrategy = evaluationStrategy;
    state.workUnits = normalizeWorkUnits(payload.workUnits, contract, {
      allowEmpty: architectureDecisionOnly,
    });
    if (
      isCompact(state) &&
      (evaluationStrategy !== "combined" ||
        Object.keys(state.workUnits).length !== 1 ||
        Object.values(state.workUnits)[0].dependsOn.length)
    ) {
      invalid(
        "invalid_plan",
        "light compact exige evaluación combined y una sola unidad sin dependencias.",
      );
    }
    state.lifecycle = architectureDecisionOnly ? "evaluating" : "executing";
    delete state.pendingInput;
    delete state.pendingPlan;
    return { result: { acceptanceContractHash: contract.hash, decision: "accepted" } };
  }

  if (command.type === "record-user-input") {
    if (state.lifecycle !== "awaiting_input") {
      invalid("invalid_transition", "record-user-input exige awaiting_input.");
    }
    assertNonEmptyString(payload.reference, "reference");
    state.lastUserInput = { reference: payload.reference, receivedAt: clock.nowUtc() };
    state.lifecycle = state.pendingInput?.resumeLifecycle ?? "planning";
    delete state.pendingInput;
    return { result: { decision: "recorded" } };
  }

  if (command.type === "dispatch-attempt") {
    if (!ROLES.has(payload.role)) invalid("invalid_command", "Rol desconocido.");
    assertOpaqueIdentifier(payload.attemptId, "attemptId");
    for (const field of ["objective", "rules", "tasks"]) assertNonEmptyString(payload[field], field);
    if (!Array.isArray(payload.findings ?? [])) {
      invalid("invalid_command", "dispatch-attempt.findings debe ser una lista.");
    }
    if (Object.hasOwn(payload, "retryCause") && !RETRY_CAUSES.has(payload.retryCause)) {
      invalid("invalid_command", "dispatch-attempt.retryCause no pertenece a la lista admitida.");
    }
    if (Object.hasOwn(payload, "elevation")) {
      assertRecord(payload.elevation, "elevation");
      assertExactKeys(
        payload.elevation,
        new Set(["approved", "durationMs", "required"]),
        "elevation",
        "invalid_command",
      );
      if (
        typeof payload.elevation.required !== "boolean" ||
        (Object.hasOwn(payload.elevation, "approved") &&
          typeof payload.elevation.approved !== "boolean") ||
        !Number.isFinite(payload.elevation.durationMs) ||
        payload.elevation.durationMs < 0
      ) {
        invalid("invalid_command", "elevation contiene tipos o duración inválidos.");
      }
    }
    if (Object.hasOwn(state.attempts, payload.attemptId)) {
      invalid("attempt_exists", "El intento ya existe.");
    }
    const planningAttempt =
      state.lifecycle === "planning" &&
      (["explorador", "planificador"].includes(payload.role) ||
        (!state.acceptanceContractHash &&
          state.workflow === "bugfix" &&
          payload.role === "tester" &&
          payload.phase === "bugfix-reproduce"));
    if (!state.acceptanceContractHash && !planningAttempt) {
      invalid("invalid_transition", "No existe contrato aprobado para este intento.");
    }
    if (planningAttempt) {
      // La planificación conserva su scope hash inmutable hasta aceptar el contrato.
    } else if (payload.role === "implementador") {
      if (state.lifecycle !== "executing") invalid("invalid_transition", "Implementador exige executing.");
      const unit = state.workUnits[payload.workUnitId];
      if (!unit || !["pending", "needs_rework"].includes(unit.status)) {
        invalid("work_unit_not_ready", "La unidad no está lista para implementación.");
      }
      if (unit.dependsOn.some((id) => !state.workUnits[id].consolidated)) {
        invalid("work_unit_not_ready", "La unidad conserva dependencias pendientes.");
      }
    } else if (payload.role === "tester") {
      if (payload.laneId?.startsWith("full:")) {
        if (
          payload.laneId !== `full:${state.generation}` ||
          state.lifecycle !== "fan_in_validation" ||
          !allUnitsConsolidated(state)
        ) {
          invalid("fan_in_pending", "El lane full no abre antes del fan-in.");
        }
      } else {
        if (state.lifecycle !== "unit_validation") {
          invalid("invalid_transition", "Tester de unidad exige unit_validation.");
        }
        if (state.workUnits[payload.workUnitId]?.status !== "implemented") {
          invalid("work_unit_not_ready", "La unidad no está implementada.");
        }
      }
    } else if (payload.role === "evaluador") {
      if (state.lifecycle !== "evaluating") invalid("invalid_transition", "Evaluador exige evaluating.");
      if (!expectedAxes(state).includes(payload.evaluationAxis)) {
        invalid("invalid_evaluation_axis", "El eje no pertenece a la estrategia vigente.");
      }
      if (
        Object.values(state.attempts).some(
          (attempt) =>
            attempt.state === "active" &&
            attempt.role === "evaluador" &&
            attempt.evaluationAxis === payload.evaluationAxis &&
            attempt.envelope.generation === state.generation,
        )
      ) {
        invalid("evaluation_axis_active", "El eje ya tiene un intento activo en esta generación.");
      }
      const generation = (state.evaluations[String(state.generation)] ??= { axes: {} });
      if (generation.axes[payload.evaluationAxis]?.state === "completed") {
        invalid("evaluation_axis_complete", "El eje ya fue consolidado.");
      }
    } else if (payload.role === "documentador") {
      if (state.lifecycle !== "documenting") invalid("invalid_transition", "Documentador exige documenting.");
    }
    const manifest = normalizeContextManifest(payload.contextManifest ?? [], state.contextBudgetBytes);
    const envelope = makeEnvelope(state, payload, manifest);
    state.attempts[payload.attemptId] = {
      attemptId: payload.attemptId,
      contractHash: envelope.acceptanceContractHash,
      envelope: clone(envelope),
      evaluationAxis: payload.evaluationAxis,
      laneId: payload.laneId,
      openedAt: clock.nowUtc(),
      openedMonotonic: clock.nowMonotonic(),
      permission: WRITER_ROLES.has(payload.role) ? "writer" : "read-only",
      planningAttempt,
      role: payload.role,
      state: "active",
      workUnitId: payload.workUnitId,
    };
    return { context: manifest, result: { envelope } };
  }

  if (command.type === "accept-role-report") {
    assertOpaqueIdentifier(payload.attemptId, "attemptId");
    const attempt = state.attempts[payload.attemptId];
    if (!attempt || attempt.state !== "active") invalid("attempt_not_active", "El intento no está activo.");
    const report = validateRoleReport(payload.report, state, attempt);
    completeAttempt(attempt, report, clock);
    for (const finding of report.findings) mergeFinding(state, finding, attempt.attemptId);
    if (report.completion === "needs_input") {
      const resumeLifecycle = state.lifecycle;
      state.lifecycle = "awaiting_input";
      state.pendingInput = {
        attemptId: attempt.attemptId,
        reason: "role_needs_input",
        resumeLifecycle,
      };
      return { result: { decision: "needs_input" } };
    }
    if (attempt.planningAttempt) {
      state.lifecycle = "planning";
      return { result: { decision: report.decision, phase: attempt.envelope.phase } };
    }
    if (attempt.role === "implementador") {
      const unit = state.workUnits[attempt.workUnitId];
      if (report.decision === "pass") {
        unit.status = "implemented";
        state.lifecycle = isCompact(state) ? "evaluating" : "unit_validation";
      } else {
        unit.status = "needs_rework";
        state.lifecycle = "executing";
      }
      return { result: { decision: report.decision, workUnitId: attempt.workUnitId } };
    }
    if (attempt.role === "tester") {
      if (attempt.laneId?.startsWith("full:")) {
        if (report.decision === "fail") {
          invalidateForRework(state, "full_validation_report_failed");
        }
        return {
          result: {
            decision: report.decision === "pass" ? "lane_reported" : "fail",
            laneId: attempt.laneId,
          },
        };
      }
      const unit = state.workUnits[attempt.workUnitId];
      if (report.decision === "pass") {
        unit.consolidated = true;
        unit.status = "validated";
        unit.validated = true;
        if (allUnitsConsolidated(state)) {
          state.lifecycle = state.mode === "full" ? "fan_in_validation" : "evaluating";
        } else {
          state.lifecycle = "executing";
        }
      } else {
        unit.consolidated = false;
        unit.status = "needs_rework";
        unit.validated = false;
        state.lifecycle = "executing";
      }
      return { result: { decision: report.decision, workUnitId: attempt.workUnitId } };
    }
    if (attempt.role === "evaluador") {
      const evaluation = (state.evaluations[String(state.generation)] ??= { axes: {} });
      evaluation.axes[attempt.evaluationAxis] = {
        attemptId: attempt.attemptId,
        decision: report.decision,
        findings: clone(report.findings),
        state: "completed",
      };
      if (!expectedAxes(state).every((axis) => evaluation.axes[axis]?.state === "completed")) {
        return { result: { decision: "axis_recorded", evaluationAxis: attempt.evaluationAxis } };
      }
      return { result: finishEvaluation(state) };
    }
    if (attempt.role === "documentador") {
      if (report.decision !== "pass") invalid("invalid_role_report", "Documentador no completó su gate.");
      state.documentation = { attemptId: attempt.attemptId, decision: "completed" };
      state.lifecycle = "completed";
      return { result: { decision: "completed" } };
    }
    return { result: { decision: report.decision } };
  }

  if (command.type === "record-attempt-failure") {
    assertOpaqueIdentifier(payload.attemptId, "attemptId");
    const attempt = state.attempts[payload.attemptId];
    if (!attempt || attempt.state !== "active") invalid("attempt_not_active", "El intento no está activo.");
    failAttempt(attempt, payload, clock);
    if (attempt.role === "implementador" || (attempt.role === "tester" && !attempt.laneId)) {
      const unit = state.workUnits[attempt.workUnitId];
      unit.consolidated = false;
      unit.status = "needs_rework";
      unit.validated = false;
      state.lifecycle = "executing";
    }
    return {
      result: {
        attemptId: attempt.attemptId,
        decision: "attempt_failed",
        retryCause: payload.retryCause,
      },
    };
  }

  if (command.type === "record-validation") {
    const evidence = validateValidationEvidence(payload.evidence, state);
    const current = state.validations[evidence.laneId];
    if (current?.fingerprint === evidence.fingerprint) {
      return {
        noTransition: true,
        result: { decision: current.decision, fingerprint: current.fingerprint, reused: true },
      };
    }
    if (state.lifecycle !== "fan_in_validation" || !allUnitsConsolidated(state)) {
      invalid("fan_in_pending", "La validación full exige todas las unidades consolidadas.");
    }
    state.validations[evidence.laneId] = evidence;
    if (evidence.decision === "pass") {
      state.lifecycle = "evaluating";
    } else {
      invalidateForRework(state, "full_validation_failed");
    }
    return {
      result: { decision: evidence.decision, fingerprint: evidence.fingerprint, reused: false },
      validation: evidence,
    };
  }

  if (command.type === "amend-scope") {
    if (state.lifecycle !== "scope_decision_required") {
      invalid("invalid_transition", "amend-scope exige scope_decision_required.");
    }
    const contract = validateAcceptanceContract(payload.acceptanceContract);
    const firstStructuredContract = !state.acceptanceContract;
    if (
      (!firstStructuredContract && contract.contractId !== state.acceptanceContract.contractId) ||
      contract.version !== (firstStructuredContract ? 1 : state.acceptanceContract.version + 1) ||
      contract.hash === state.acceptanceContractHash
    ) {
      invalid("invalid_scope_amendment", "La ampliación debe crear una versión y hash nuevos.");
    }
    if (!firstStructuredContract) assertScopeExtension(state.acceptanceContract, contract);
    assertNonEmptyString(payload.approvalReference, "approvalReference");
    if (
      Object.hasOwn(payload, "additionalReworkCycles") &&
      (!Number.isInteger(payload.additionalReworkCycles) || payload.additionalReworkCycles < 1)
    ) {
      invalid("invalid_scope_amendment", "additionalReworkCycles debe ser un entero positivo.");
    }
    state.scopeAmendments ??= [];
    const incorporatedFindings = [...(state.scopeDecision?.findingFingerprints ?? [])];
    state.scopeAmendments.push({
      approvalReference: payload.approvalReference,
      findingFingerprints: incorporatedFindings,
      fromHash: state.acceptanceContractHash,
      toHash: contract.hash,
      version: contract.version,
    });
    for (const fingerprint of incorporatedFindings) {
      if (state.findings[fingerprint]) {
        state.findings[fingerprint].resolutionReference = payload.approvalReference;
        state.findings[fingerprint].status = "incorporated";
      }
    }
    state.acceptanceContract = contract;
    state.acceptanceContractHash = contract.hash;
    if (payload.additionalReworkCycles) {
      state.maxEvaluationReworkCycles += payload.additionalReworkCycles;
    }
    state.lifecycle = "planning";
    state.scopeDecision = undefined;
    state.generation += 1;
    return { result: { acceptanceContractHash: contract.hash, decision: "amended" } };
  }

  if (command.type === "resolve-scope-decision") {
    if (state.lifecycle !== "scope_decision_required") {
      invalid("invalid_transition", "resolve-scope-decision exige scope_decision_required.");
    }
    if (!new Set(["accept-risk", "cancel", "defer"]).has(payload.action)) {
      invalid("invalid_command", "action debe ser accept-risk, defer o cancel; amend usa amend-scope.");
    }
    assertNonEmptyString(payload.reference, "reference");
    state.scopeResolution = { action: payload.action, reference: payload.reference };
    for (const fingerprint of state.scopeDecision.findingFingerprints ?? []) {
      const storedFinding = state.findings[fingerprint];
      if (!storedFinding) continue;
      storedFinding.resolutionReference = payload.reference;
      storedFinding.status =
        payload.action === "defer"
          ? "deferred"
          : payload.action === "accept-risk"
            ? "risk_accepted"
            : "cancelled";
      if (payload.action === "defer" && !state.deferredFindings.includes(fingerprint)) {
        state.deferredFindings.push(fingerprint);
      }
    }
    if (payload.action === "cancel") {
      state.lifecycle = "closed_rejected";
    } else if (state.scopeDecision.blockingFindingFingerprints?.length) {
      if (state.evaluationReworkCycles >= state.maxEvaluationReworkCycles) {
        state.scopeDecision = {
          findingFingerprints: [...state.scopeDecision.blockingFindingFingerprints],
          options: ["amend", "defer", "accept-risk", "cancel"],
          reason: "rework_budget_exhausted",
        };
        return { result: { decision: "scope_decision_required", reason: "rework_budget_exhausted" } };
      }
      state.evaluationReworkCycles += 1;
      invalidateForRework(state, "evaluation_rejected_after_scope_resolution");
      state.scopeDecision = undefined;
      return {
        result: {
          decision: "changes_required",
          evaluationReworkCycle: state.evaluationReworkCycles,
        },
      };
    } else if (!state.acceptanceContractHash) {
      state.lifecycle = "planning";
    } else if (state.documentationRequired) {
      validateCompactUnit(state);
      state.lifecycle = "documenting";
    } else {
      validateCompactUnit(state);
      state.documentation = { decision: "not_applicable", reason: state.documentationReason };
      state.lifecycle = "completed";
    }
    state.scopeDecision = undefined;
    return { result: { decision: payload.action } };
  }

  if (command.type === "close-session") {
    if (!new Set(["completed", "closed_rejected"]).has(state.lifecycle)) {
      invalid("invalid_transition", "close-session exige una sesión terminal.");
    }
    state.closed = true;
    state.closedAt = clock.nowUtc();
    return { result: { decision: "closed", finalState: state.lifecycle } };
  }

  invalid("invalid_transition", `El comando ${command.type} no aplica al estado actual.`);
}

export class OrchestrationKernel {
  constructor({
    bootstrapCapability,
    capabilityRegistry = new MemoryCapabilityRegistry(),
    clock = new SystemClock(),
    configuration = {},
    environmentProbe = new SystemEnvironmentProbe(),
    eventSink,
    stateStore,
  } = {}) {
    if (!bootstrapCapability) throw new TypeError("bootstrapCapability es obligatorio.");
    if (!stateStore) throw new TypeError("stateStore es obligatorio; producción debe usar un store durable.");
    for (const method of [
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
    ]) {
      if (typeof stateStore[method] !== "function") {
        throw new TypeError(`stateStore debe implementar ${method}().`);
      }
    }
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      throw new TypeError("configuration debe ser un objeto.");
    }
    const unsupportedConfiguration = Object.keys(configuration).filter(
      (key) => !new Set(["capabilityTtlMs", "contextBudgetBytes"]).has(key),
    );
    if (unsupportedConfiguration.length) {
      throw new TypeError(`configuration contiene campos no admitidos: ${unsupportedConfiguration.join(", ")}.`);
    }
    this.bootstrapCapability = bootstrapCapability;
    this.capabilityRegistry = capabilityRegistry;
    this.clock = clock;
    const capabilityTtlMs = configuration.capabilityTtlMs ?? 3_600_000;
    const contextBudgetBytes = configuration.contextBudgetBytes ?? 128_000;
    if (!Number.isFinite(capabilityTtlMs) || capabilityTtlMs <= 0) {
      throw new TypeError("capabilityTtlMs debe ser positivo y finito.");
    }
    if (!Number.isInteger(contextBudgetBytes) || contextBudgetBytes < 1) {
      throw new TypeError("contextBudgetBytes debe ser un entero positivo.");
    }
    this.configuration = {
      capabilityTtlMs,
      contextBudgetBytes,
    };
    this.environmentProbe = environmentProbe;
    this.eventSink = eventSink ?? stateStore.eventSink ?? new MemoryEventSink();
    this.stateStore = stateStore;
    for (const [label, adapter, methods] of [
      ["capabilityRegistry", this.capabilityRegistry, ["authorize", "capabilityFor", "issue"]],
      ["clock", this.clock, ["nowMonotonic", "nowUtc"]],
      ["environmentProbe", this.environmentProbe, ["run"]],
      ["eventSink", this.eventSink, ["append"]],
    ]) {
      for (const method of methods) {
        if (typeof adapter?.[method] !== "function") {
          throw new TypeError(`${label} debe implementar ${method}().`);
        }
      }
    }
  }

  async apply(command) {
    validateBaseCommand(command);
    assertExactKeys(
      command,
      new Set([
        "actorCapability",
        "commandId",
        "expectedRevision",
        "payload",
        "schemaVersion",
        "sessionId",
        "type",
      ]),
      "command",
      "invalid_command",
    );
    if (containsReference(command.payload, command.actorCapability)) {
      invalid("capability_leak", "La capacidad del actor no puede aparecer dentro del payload.");
    }
    if (!COMMAND_TYPES.has(command.type)) invalid("unknown_command", `Comando desconocido: ${command.type}.`);
    validateCommandPayload(command);
    const startedAt = this.clock.nowUtc();
    const startedMonotonic = this.clock.nowMonotonic();
    const fingerprint = commandFingerprint(command);

    return this.stateStore.withGlobalLock(() =>
      this.stateStore.withLock(command.sessionId, async () => {
        const recorded = await this.stateStore.findCommand(command.commandId);
        if (recorded) {
          const recordedState = await this.stateStore.load(recorded.sessionId);
          validateSnapshot(recordedState, recorded.sessionId);
          if (
            command.type === "start-session"
              ? command.actorCapability !== this.bootstrapCapability &&
                !this.capabilityRegistry.authorize(
                  command.sessionId,
                  command.actorCapability,
                  this.clock.nowMonotonic(),
                )
              : !this.capabilityRegistry.authorize(
                  command.sessionId,
                  command.actorCapability,
                  this.clock.nowMonotonic(),
                )
          ) {
            invalid("actor_not_authorized", "La capacidad no autoriza el retry.");
          }
          if (recorded.sessionId !== command.sessionId || recorded.command.fingerprint !== fingerprint) {
            invalid("idempotency_conflict", "commandId ya fue usado con otro payload.");
          }
          const recordedTerminalAttempt = terminalWriterAttempt(recordedState, command);
          if (recordedTerminalAttempt) {
            await this.stateStore.releaseWriter(
              await writerOwner(
                this.stateStore,
                recordedState.sessionId,
                recordedTerminalAttempt.attemptId,
              ),
              { preserveForeignOwner: true },
            );
          }
          const result = clone(recorded.command.result);
          await deliverPendingEvents(this, recordedState, command.commandId, result);
          if (command.type === "start-session") {
            let capability = this.capabilityRegistry.capabilityFor(command.sessionId);
            if (
              !this.capabilityRegistry.authorize(
                command.sessionId,
                capability,
                this.clock.nowMonotonic(),
              )
            ) {
              capability = this.capabilityRegistry.issue(
                command.sessionId,
                this.clock.nowMonotonic() + this.configuration.capabilityTtlMs,
              );
            }
            result.actorCapability = capability;
          }
          return protectWorkEnvelope(result);
        }

        let state = await this.stateStore.load(command.sessionId);
        if (state) validateSnapshot(state, command.sessionId);
        let issuedCapability;
        let transition;
        let transitionFromRevision;
        let transitionFromState;
        let writerToRelease;

        if (command.type === "start-session") {
          authorizeStart(this, command);
          if (state) invalid("session_exists", "La sesión ya existe.");
          if (command.expectedRevision !== 0) invalid("stale_revision", "Una sesión nueva exige revisión 0.");
          const normalizedConfiguration = normalizeStartConfiguration(
            command.payload ?? {},
            this.configuration,
          );
          const environment = await this.environmentProbe.run({
            requirements: command.payload?.requirements ?? {},
            sessionId: command.sessionId,
            store: this.stateStore,
          });
          if (!environment.ok) {
            invalid("environment_failed", "El preflight falló antes de crear la sesión.", environment);
          }
          state = startState(
            command,
            environment,
            this.clock,
            this.configuration,
            normalizedConfiguration,
          );
          transitionFromRevision = 0;
          transitionFromState = "preflight";
          issuedCapability = this.capabilityRegistry.issue(
            command.sessionId,
            this.clock.nowMonotonic() + this.configuration.capabilityTtlMs,
          );
          transition = { result: { decision: "started" } };
        } else {
          if (!state) invalid("session_not_found", "La sesión no existe.");
          authorizeSession(this, state, command);
          requireRevision(command, state);
          state = clone(state);
          transitionFromRevision = state.revision;
          transitionFromState = state.lifecycle;
          transition = applyToState(state, command, this.clock);
          if (
            command.type === "dispatch-attempt" &&
            WRITER_ROLES.has(command.payload?.role)
          ) {
            const owner = await writerOwner(
              this.stateStore,
              state.sessionId,
              command.payload.attemptId,
            );
            const activeWriter = await this.stateStore.findActiveWriter();
            if (activeWriter && !sameWriterOwner(activeWriter, owner)) {
              invalid(
                "writer_locked",
                `El working tree ya tiene un writer activo: ${activeWriter.session}/${activeWriter.attempt}.`,
                activeWriter,
              );
            }
            await this.stateStore.acquireWriter(owner, {
              commandFingerprint: fingerprint,
              commandId: command.commandId,
              expectedRevision: command.expectedRevision,
            });
          }
          const terminalAttempt = terminalWriterAttempt(state, command);
          if (terminalAttempt) {
            writerToRelease = await writerOwner(
              this.stateStore,
              state.sessionId,
              terminalAttempt.attemptId,
            );
          }
        }

        const beforeRevision = transitionFromRevision;
        const beforeState = transitionFromState;
        if (!transition.noTransition) state.revision += 1;
        const result = {
          ...clone(transition.result),
          revision: state.revision,
          sessionId: state.sessionId,
          state: state.lifecycle,
        };
        state.commands[command.commandId] = { fingerprint, result: clone(result) };
        if (transition.noTransition) {
          await this.stateStore.save(state.sessionId, state);
          return result;
        }

        const endedAt = this.clock.nowUtc();
        const endedMonotonic = this.clock.nowMonotonic();
        const event = {
          actor: "orchestrator",
          commandId: command.commandId,
          commandType: command.type,
          durationMs: Math.max(0, endedMonotonic - startedMonotonic),
          endedAt,
          eventId: eventId(command.commandId),
          fromRevision: beforeRevision,
          fromState: beforeState,
          schemaVersion: SCHEMA_VERSION,
          sessionId: state.sessionId,
          startedAt,
          stateDurationMs: Math.max(0, startedMonotonic - state.stateEnteredMonotonic),
          toRevision: state.revision,
          toState: state.lifecycle,
          ...telemetryData(command, transition),
        };
        if (beforeState !== state.lifecycle) {
          state.stateEnteredAt = endedAt;
          state.stateEnteredMonotonic = endedMonotonic;
        }
        state.telemetry.pendingEvents[event.eventId] = clone(event);
        await this.stateStore.save(state.sessionId, state);
        if (writerToRelease) await this.stateStore.releaseWriter(writerToRelease);
        await deliverPendingEvents(this, state, command.commandId, result);
        if (issuedCapability) result.actorCapability = issuedCapability;
        return protectWorkEnvelope(result);
      }),
    );
  }

  async inspect(sessionId) {
    validateSessionId(sessionId);
    const state = await this.stateStore.load(sessionId);
    if (state) {
      validateSnapshot(state, sessionId);
      return sessionView(state);
    }
    invalid("session_not_found", "La sesión no existe.");
  }
}
