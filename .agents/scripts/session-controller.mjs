#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";

const BLOCK_START = "<!-- agentic-session:v1:start -->";
const BLOCK_END = "<!-- agentic-session:v1:end -->";
const COMMANDS = new Set([
  "init",
  "open",
  "await-input",
  "resume",
  "commit",
  "fail",
  "status",
  "recover",
  "cleanup",
  "close",
]);
const MUTATING_COMMANDS = new Set([
  "init",
  "open",
  "await-input",
  "resume",
  "commit",
  "fail",
  "cleanup",
  "close",
]);
const ATTEMPT_PATTERN = /^([a-z][a-z0-9-]*)--([a-z][a-z0-9-]*)--a(\d{2,})$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORK_UNIT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DUAL_EVALUATION_RISKS = new Set([
  "architectural-decision",
  "considerable-fan-in",
  "public-compatibility-or-migration",
  "security-or-integrity",
]);
const MODE_LIMITS = {
  full: {
    roles: { documentador: 1, evaluador: 2, explorador: 3, implementador: 1, planificador: 1, tester: 2 },
    total: 9,
  },
  light: {
    roles: { documentador: 1, evaluador: 1, explorador: 2, implementador: 1, planificador: 1, tester: 1 },
    total: 4,
  },
};
let activeMutationLockToken;

class ControllerError extends Error {
  constructor(id, message, exitCode = 1) {
    super(message);
    this.id = id;
    this.exitCode = exitCode;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value, indentation = 0) {
  return JSON.stringify(stableValue(value), null, indentation);
}

function normalizedText(source) {
  if (source.startsWith("\uFEFF")) {
    throw new ControllerError("invalid_utf8", "El contenido hashable no admite BOM.");
  }
  return source.replace(/\r\n?/g, "\n");
}

function hashText(source) {
  return createHash("sha256").update(normalizedText(source), "utf8").digest("hex");
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    throw new ControllerError("usage", "Comando ausente o desconocido.", 2);
  }
  const options = { command, root: process.cwd() };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!["--root", "--session", "--attempt", "--expected-revision"].includes(flag)) {
      throw new ControllerError("usage", `Bandera desconocida: ${flag}.`, 2);
    }
    const value = rest[index + 1];
    if (value === undefined) {
      throw new ControllerError("usage", `Falta el valor de ${flag}.`, 2);
    }
    index += 1;
    if (flag === "--root") options.root = resolve(value);
    if (flag === "--session") options.session = value;
    if (flag === "--attempt") options.attempt = value;
    if (flag === "--expected-revision") {
      if (!/^\d+$/.test(value)) {
        throw new ControllerError("usage", "--expected-revision debe ser un entero no negativo.", 2);
      }
      options.expectedRevision = Number(value);
    }
  }
  if (!options.session || !SLUG_PATTERN.test(options.session)) {
    throw new ControllerError("usage", "--session debe ser un slug válido.", 2);
  }
  if (MUTATING_COMMANDS.has(command) && options.expectedRevision === undefined) {
    throw new ControllerError("usage", "La mutación exige --expected-revision.", 2);
  }
  return options;
}

async function readUtf8(path) {
  const bytes = await readFile(path);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new ControllerError("invalid_utf8", `${path} contiene BOM.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ControllerError("invalid_utf8", `${path} no contiene UTF-8 válido.`);
  }
}

function splitManaged(source, path) {
  const starts = source.split(BLOCK_START).length - 1;
  const ends = source.split(BLOCK_END).length - 1;
  if (starts === 0 && ends === 0) return { human: source, managed: null };
  if (starts !== 1 || ends !== 1 || source.indexOf(BLOCK_START) > source.indexOf(BLOCK_END)) {
    throw new ControllerError("ambiguous_managed_block", `${path} contiene marcadores ambiguos.`);
  }
  const start = source.indexOf(BLOCK_START);
  const end = source.indexOf(BLOCK_END, start);
  const between = source.slice(start + BLOCK_START.length, end).trim();
  const match = between.match(/^```json\n([\s\S]*)\n```$/);
  if (!match) {
    throw new ControllerError("invalid_managed_block", `${path} contiene un bloque administrado inválido.`);
  }
  let managed;
  try {
    managed = JSON.parse(match[1]);
  } catch {
    throw new ControllerError("invalid_managed_json", `${path} contiene JSON administrado inválido.`);
  }
  if (managed.version !== 1) {
    throw new ControllerError("unsupported_version", `${path} usa una versión no soportada.`);
  }
  const suffix = source.slice(end + BLOCK_END.length);
  if (suffix.trim()) {
    throw new ControllerError("ambiguous_managed_block", `${path} contiene datos después del bloque.`);
  }
  return { human: source.slice(0, start).replace(/\n{2}$/, "\n"), managed };
}

function withManaged(human, managed) {
  const prefix = human.endsWith("\n") ? human : `${human}\n`;
  return `${prefix}\n${BLOCK_START}\n\`\`\`json\n${stableJson(managed, 2)}\n\`\`\`\n${BLOCK_END}\n`;
}

async function readPayload() {
  if (!MUTATING_COMMANDS.has(currentOptions.command)) return {};
  let source = "";
  for await (const chunk of stdin) source += chunk;
  if (!source.trim()) return {};
  try {
    const parsed = JSON.parse(source);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw new ControllerError("invalid_payload", "stdin debe contener un objeto JSON válido.", 2);
  }
}

async function atomicWrite(path, source) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await openFile(temporary, "wx");
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function isProcessActive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function inspectMutationLock(lockPath) {
  let source;
  try {
    source = await readUtf8(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { classification: "ambiguous", source: null, state: "invalid" };
  }
  try {
    const owner = JSON.parse(source);
    if (
      !owner ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      (owner.token !== undefined && (typeof owner.token !== "string" || !owner.token))
    ) {
      throw new Error();
    }
    const state = isProcessActive(owner.pid) ? "active" : "abandoned";
    return { classification: "recoverable", owner, source, state };
  } catch {
    return { classification: "ambiguous", source, state: "invalid" };
  }
}

async function removeRecoverableLockCandidates(lockPath) {
  const prefix = `${lockPath.slice(0, -".lock".length)}.tmp-lock-`;
  for (const entry of await readdir(dirname(lockPath), { withFileTypes: true })) {
    const candidatePath = join(dirname(lockPath), entry.name);
    if (!entry.isFile() || !candidatePath.startsWith(prefix)) continue;
    const candidate = await inspectMutationLock(candidatePath);
    if (candidate?.state === "active") continue;
    await rm(candidatePath, { force: true });
  }
}

async function publishMutationLock(lockPath, owner) {
  const candidatePath = `${lockPath.slice(0, -".lock".length)}.tmp-lock-${owner.pid}-${owner.token}`;
  let candidate;
  try {
    candidate = await openFile(candidatePath, "wx");
    await candidate.writeFile(stableJson(owner), "utf8");
    await candidate.sync();
    await candidate.close();
    candidate = undefined;
    await link(candidatePath, lockPath);
  } finally {
    await candidate?.close().catch(() => {});
    await rm(candidatePath, { force: true }).catch(() => {});
  }
}

async function acquireMutationLock(lockPath, owner) {
  await removeRecoverableLockCandidates(lockPath);
  try {
    await publishMutationLock(lockPath, owner);
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const observed = await inspectMutationLock(lockPath);
  if (!observed || observed.state !== "abandoned") {
    throw new ControllerError("session_locked", "La DevSession tiene otra mutación en curso.");
  }
  let currentSource;
  try {
    currentSource = await readUtf8(lockPath);
  } catch {
    currentSource = null;
  }
  if (currentSource !== observed.source) {
    throw new ControllerError("session_locked", "El lock cambió durante su recuperación.");
  }
  await rm(lockPath);
  try {
    await publishMutationLock(lockPath, owner);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new ControllerError("session_locked", "La DevSession tiene otra mutación en curso.");
    }
    throw error;
  }
}

async function withMutationLock(options, operation) {
  const { global, sessions } = sessionPaths(options);
  await mkdir(sessions, { recursive: true });
  const lockPath = `${global}.lock`;
  const token = randomUUID();
  let acquired = false;
  activeMutationLockToken = token;
  try {
    await acquireMutationLock(lockPath, { pid: process.pid, token });
    acquired = true;
    return await operation();
  } finally {
    activeMutationLockToken = undefined;
    if (acquired) await rm(lockPath, { force: true }).catch(() => {});
  }
}

function assertRevision(expected, actual) {
  if (expected !== actual) {
    throw new ControllerError(
      "stale_revision",
      `Revisión obsoleta: se esperaba ${expected} y la actual es ${actual}.`,
    );
  }
}

function sessionPaths(options) {
  const sessions = join(options.root, ".agents", "sessions");
  return {
    global: join(sessions, `${options.session}.md`),
    sessions,
    subdirectory: join(sessions, options.session),
  };
}

async function writerReservation(options) {
  const canonicalRoot = (await realpath(options.root)).replaceAll("\\", "/");
  const workingTree = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  const workingTreeId = createHash("sha256").update(workingTree, "utf8").digest("hex");
  return {
    lockPath: join(options.root, ".agents", "sessions", `.writer-${workingTreeId}.lock`),
    owner: { attempt: options.attempt, session: options.session, workingTreeId },
  };
}

async function acquireWriterReservation(options) {
  const { lockPath, owner } = await writerReservation(options);
  await mkdir(dirname(lockPath), { recursive: true });
  const candidatePath = `${lockPath}.tmp-${process.pid}-${randomUUID()}`;
  let candidate;
  try {
    candidate = await openFile(candidatePath, "wx");
    await candidate.writeFile(stableJson(owner), "utf8");
    await candidate.sync();
    await candidate.close();
    candidate = undefined;
    try {
      await link(candidatePath, lockPath);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let observed;
    try {
      observed = JSON.parse(await readUtf8(lockPath));
    } catch {
      observed = null;
    }
    if (stableJson(observed) !== stableJson(owner)) {
      throw new ControllerError("writer_conflict", "Ya existe un escritor activo en el working tree.");
    }
  } finally {
    await candidate?.close().catch(() => {});
    await rm(candidatePath, { force: true }).catch(() => {});
  }
}

async function releaseWriterReservation(options, { preserveForeignOwner = false } = {}) {
  const { lockPath, owner } = await writerReservation(options);
  let observed;
  try {
    observed = JSON.parse(await readUtf8(lockPath));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new ControllerError("writer_lock_ambiguous", "El writer lock no es interpretable.");
  }
  if (stableJson(observed) !== stableJson(owner)) {
    if (preserveForeignOwner) return false;
    throw new ControllerError("writer_lock_conflict", "El writer lock pertenece a otro intento.");
  }
  await rm(lockPath);
  return true;
}

async function readGlobal(options, required = true) {
  const paths = sessionPaths(options);
  if (!existsSync(paths.global)) {
    if (required) throw new ControllerError("session_not_found", "La DevSession no existe.");
    return { ...paths, exists: false, human: "", managed: null };
  }
  const source = await readUtf8(paths.global);
  return { ...paths, exists: true, source, ...splitManaged(source, paths.global) };
}

function validateGlobal(managed, session) {
  if (!managed) return;
  if (managed.kind !== "global" || managed.sessionSlug !== session) {
    throw new ControllerError("session_identity_conflict", "La identidad del bloque global contradice la ruta.");
  }
  if (managed.evaluationStrategy !== undefined) {
    if (!["combined", "dual"].includes(managed.evaluationStrategy)) {
      throw new ControllerError(
        "invalid_managed_evaluation",
        "La estrategia de evaluación persistida no es válida.",
      );
    }
    if (
      managed.evaluationStrategy === "dual" &&
      !DUAL_EVALUATION_RISKS.has(managed.evaluationRisk) &&
      managed.evaluationRisk !== "legacy-full-mode"
    ) {
      throw new ControllerError(
        "invalid_managed_evaluation",
        "La evaluación dual persistida no declara un riesgo válido.",
      );
    }
    if (managed.evaluationStrategy === "combined" && managed.evaluationRisk !== undefined) {
      throw new ControllerError(
        "invalid_managed_evaluation",
        "La evaluación combinada persistida no admite un riesgo dual.",
      );
    }
  }
}

function renderGlobalTemplate(template, { mode, objective, session, workflow }) {
  return template
    .replace("<slug>", session)
    .replace("- Objetivo:", `- Objetivo: ${objective ?? "Pendiente"}`)
    .replace("- Workflow: feature | bugfix | refactor | architecture", `- Workflow: ${workflow}`)
    .replace("- Modo: full | light", `- Modo: ${mode ?? "full"}`)
    .replace("- Fase actual:", "- Fase actual: Pendiente");
}

function canonicalOwnedPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new ControllerError("invalid_owned_path", "ownedPaths exige rutas relativas canónicas.", 2);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ControllerError("invalid_owned_path", "ownedPaths exige rutas relativas canónicas.", 2);
  }
  const portableSegments = segments.map((segment) => segment.replace(/[ .]+$/u, "").toLowerCase());
  if (portableSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ControllerError("invalid_owned_path", "ownedPaths contiene un alias no portable.", 2);
  }
  return portableSegments.join("/");
}

function pathsCollide(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function capacityConfig(payload, existing = {}) {
  const mode = payload.mode ?? existing.mode ?? "full";
  if (!["full", "light"].includes(mode)) {
    throw new ControllerError("invalid_mode", "mode debe ser full o light.", 2);
  }
  const platformCapacity = payload.platformCapacity ?? existing.platformCapacity ?? MODE_LIMITS[mode].total;
  const readOnlyCapacity = payload.readOnlyCapacity ?? existing.readOnlyCapacity ?? platformCapacity;
  const writerIsolationCapacity =
    payload.writerIsolationCapacity ??
    payload.isolationCapacity ??
    existing.writerIsolationCapacity ??
    existing.isolationCapacity ??
    1;
  for (const [field, value] of Object.entries({
    platformCapacity,
    readOnlyCapacity,
    writerIsolationCapacity,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ControllerError("invalid_capacity", `${field} debe ser un entero positivo.`, 2);
    }
  }
  return {
    isolationCapacity: writerIsolationCapacity,
    mode,
    platformCapacity,
    readOnlyCapacity,
    writerIsolationCapacity,
  };
}

function technicalAgentCapacity(managed) {
  const modeLimit = MODE_LIMITS[managed.mode ?? "full"].total;
  return Math.min(modeLimit, managed.platformCapacity ?? modeLimit);
}

function readOnlyAgentCapacity(managed) {
  return Math.min(
    technicalAgentCapacity(managed),
    managed.readOnlyCapacity ?? managed.platformCapacity ?? technicalAgentCapacity(managed),
  );
}

function evaluationConfig(payload, existing = {}) {
  const legacyStrategy =
    existing.workUnits && !Object.hasOwn(existing, "evaluationStrategy")
      ? existing.mode === "light"
        ? "combined"
        : "dual"
      : undefined;
  const evaluationStrategy =
    payload.evaluationStrategy ?? existing.evaluationStrategy ?? legacyStrategy ?? "combined";
  if (!["combined", "dual"].includes(evaluationStrategy)) {
    throw new ControllerError(
      "invalid_evaluation_strategy",
      "evaluationStrategy debe ser combined o dual.",
      2,
    );
  }

  let evaluationRisk = payload.evaluationRisk ?? existing.evaluationRisk;
  const inferredLegacyRisk =
    evaluationStrategy === "dual" &&
    evaluationRisk === undefined &&
    legacyStrategy === "dual" &&
    payload.evaluationStrategy === undefined;
  if (inferredLegacyRisk) evaluationRisk = "legacy-full-mode";

  if (evaluationStrategy === "combined") {
    if (evaluationRisk !== undefined) {
      throw new ControllerError(
        "unexpected_evaluation_risk",
        "La evaluación combinada no admite evaluationRisk.",
        2,
      );
    }
    return { evaluationStrategy };
  }
  if (evaluationRisk === undefined) {
    throw new ControllerError(
      "evaluation_risk_required",
      "La evaluación dual exige evaluationRisk antes del fan-in.",
      2,
    );
  }
  const preservedLegacyRisk =
    evaluationRisk === "legacy-full-mode" &&
    (inferredLegacyRisk || existing.evaluationRisk === "legacy-full-mode");
  if (!DUAL_EVALUATION_RISKS.has(evaluationRisk) && !preservedLegacyRisk) {
    throw new ControllerError(
      "invalid_evaluation_risk",
      "evaluationRisk no justifica una evaluación dual.",
      2,
    );
  }
  return { evaluationRisk, evaluationStrategy };
}

function parseWorkUnits(payload, existing = {}) {
  if (payload.workUnits === undefined) return {};
  if (!Array.isArray(payload.workUnits) || !payload.workUnits.length || payload.workUnits.length > 3) {
    throw new ControllerError("invalid_work_units", "workUnits debe contener entre una y tres unidades.", 2);
  }
  const capacity = capacityConfig(payload, existing);
  const evaluation = evaluationConfig(payload, existing);

  const workUnits = {};
  for (const candidate of payload.workUnits) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ControllerError("invalid_work_units", "Cada unidad debe ser un objeto.", 2);
    }
    const { acceptanceCriteria, workUnitId, dependsOn, ownedPaths, permission } = candidate;
    if (!WORK_UNIT_PATTERN.test(workUnitId ?? "") || workUnits[workUnitId]) {
      throw new ControllerError("invalid_work_unit_id", "workUnitId debe ser único y canónico.", 2);
    }
    if (!Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length) {
      throw new ControllerError("invalid_dependencies", "dependsOn debe ser una lista sin duplicados.", 2);
    }
    if (
      !Array.isArray(acceptanceCriteria) ||
      !acceptanceCriteria.length ||
      acceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim()) ||
      new Set(acceptanceCriteria).size !== acceptanceCriteria.length ||
      !Array.isArray(ownedPaths) ||
      !["read-only", "writer"].includes(permission)
    ) {
      throw new ControllerError(
        "invalid_work_unit_contract",
        "Cada unidad exige acceptanceCriteria, ownedPaths y permission read-only o writer.",
        2,
      );
    }
    const canonicalPaths = ownedPaths.map(canonicalOwnedPath);
    if (new Set(canonicalPaths).size !== canonicalPaths.length) {
      throw new ControllerError("ownership_collision", "Una unidad repite rutas de propiedad.", 2);
    }
    workUnits[workUnitId] = {
      acceptanceCriteria: acceptanceCriteria.map((criterion) => criterion.trim()),
      dependsOn: [...dependsOn],
      ownedPaths: canonicalPaths,
      permission,
      state: "planned",
      wave: 0,
      workUnitId,
    };
  }

  for (const unit of Object.values(workUnits)) {
    if (
      unit.dependsOn.some(
        (dependency) => !WORK_UNIT_PATTERN.test(dependency) || !workUnits[dependency] || dependency === unit.workUnitId,
      )
    ) {
      throw new ControllerError("invalid_dependencies", "dependsOn referencia una unidad inválida.", 2);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function assignWave(unit) {
    if (visiting.has(unit.workUnitId)) {
      throw new ControllerError("dependency_cycle", "workUnits contiene un ciclo de dependencias.", 2);
    }
    if (visited.has(unit.workUnitId)) return unit.wave;
    visiting.add(unit.workUnitId);
    unit.wave = 1 + Math.max(0, ...unit.dependsOn.map((dependency) => assignWave(workUnits[dependency])));
    visiting.delete(unit.workUnitId);
    visited.add(unit.workUnitId);
    return unit.wave;
  }
  Object.values(workUnits).forEach(assignWave);

  const writers = Object.values(workUnits).filter((unit) => unit.permission === "writer");
  for (let left = 0; left < writers.length; left += 1) {
    for (let right = left + 1; right < writers.length; right += 1) {
      if (
        writers[left].ownedPaths.some((path) =>
          writers[right].ownedPaths.some((candidate) => pathsCollide(path, candidate)),
        )
      ) {
        throw new ControllerError(
          "ownership_collision",
          `Las unidades ${writers[left].workUnitId} y ${writers[right].workUnitId} colisionan.`,
          2,
        );
      }
    }
  }

  const modeLimit = MODE_LIMITS[capacity.mode].total;
  const readyUnits = Object.values(workUnits).filter((unit) => unit.dependsOn.length === 0);
  const readyReadOnly = readyUnits.filter((unit) => unit.permission === "read-only").length;
  const readyWriters = readyUnits.length - readyReadOnly;
  return {
    effectiveCapacity: Math.min(
      modeLimit,
      capacity.platformCapacity,
      Math.min(capacity.readOnlyCapacity, readyReadOnly) +
        Math.min(capacity.writerIsolationCapacity, readyWriters),
    ),
    ...capacity,
    ...evaluation,
    evaluationGeneration: existing.evaluationGeneration ?? 1,
    evaluations: existing.evaluations ?? {},
    workUnits,
  };
}

function comparableOwnedPaths(ownedPaths) {
  if (!Array.isArray(ownedPaths)) return ownedPaths;
  try {
    return ownedPaths.map(canonicalOwnedPath);
  } catch {
    return ownedPaths;
  }
}

function workUnitPlanDefinition(managed, missingFrom) {
  const definition = {
    evaluationRisk: managed.evaluationRisk,
    evaluationStrategy: managed.evaluationStrategy,
    isolationCapacity: managed.isolationCapacity,
    mode: managed.mode,
    platformCapacity: managed.platformCapacity,
    readOnlyCapacity: managed.readOnlyCapacity,
    writerIsolationCapacity: managed.writerIsolationCapacity,
    workUnits: Object.fromEntries(
      Object.entries(managed.workUnits).map(([workUnitId, unit]) => [
        workUnitId,
        {
          acceptanceCriteria: unit.acceptanceCriteria,
          dependsOn: unit.dependsOn,
          ownedPaths: comparableOwnedPaths(unit.ownedPaths),
          permission: unit.permission,
          wave: unit.wave,
          workUnitId: unit.workUnitId,
        },
      ]),
    ),
  };
  if (!missingFrom) return definition;
  for (const field of [
    "evaluationRisk",
    "evaluationStrategy",
    "readOnlyCapacity",
    "writerIsolationCapacity",
  ]) {
    if (!Object.hasOwn(managed, field)) definition[field] = missingFrom[field];
  }
  for (const [workUnitId, unit] of Object.entries(managed.workUnits)) {
    if (!Object.hasOwn(unit, "acceptanceCriteria") && missingFrom.workUnits[workUnitId]) {
      definition.workUnits[workUnitId].acceptanceCriteria =
        missingFrom.workUnits[workUnitId].acceptanceCriteria;
    }
  }
  return definition;
}

function completeWorkUnitPlan(managed, configured) {
  let completed = false;
  for (const field of [
    "evaluationRisk",
    "evaluationStrategy",
    "readOnlyCapacity",
    "writerIsolationCapacity",
  ]) {
    if (!Object.hasOwn(configured, field)) continue;
    if (Object.hasOwn(managed, field)) continue;
    managed[field] = configured[field];
    completed = true;
  }
  for (const [workUnitId, unit] of Object.entries(managed.workUnits)) {
    if (Object.hasOwn(unit, "acceptanceCriteria")) continue;
    unit.acceptanceCriteria = [...configured.workUnits[workUnitId].acceptanceCriteria];
    completed = true;
  }
  if (!Object.hasOwn(managed, "evaluationGeneration")) {
    managed.evaluationGeneration = 1;
    completed = true;
  }
  return completed;
}

function assertWorkUnitPlanReady(managed) {
  if (
    !managed.workUnits ||
    (Object.hasOwn(managed, "readOnlyCapacity") &&
      Object.hasOwn(managed, "writerIsolationCapacity") &&
      Object.hasOwn(managed, "evaluationGeneration") &&
      Object.values(managed.workUnits).every((unit) => Object.hasOwn(unit, "acceptanceCriteria")))
  ) {
    return;
  }
  throw new ControllerError(
    "work_unit_plan_upgrade_required",
    "La DevSession exige completar su plan de unidades mediante init antes de abrir intentos.",
  );
}

function relatedAttempt(ledger, payload) {
  if (payload.workUnitId !== undefined) return ledger.workUnitId === payload.workUnitId;
  if (payload.laneId !== undefined) return ledger.laneId === payload.laneId;
  if (payload.evaluationAxis !== undefined) return ledger.evaluationAxis === payload.evaluationAxis;
  return ledger.workUnitId === undefined && ledger.laneId === undefined && ledger.evaluationAxis === undefined;
}

function activeAttempts(managed) {
  return Object.values(managed.attempts).filter((attempt) =>
    ["active", "awaiting_input"].includes(attempt.state),
  );
}

function attemptIsWriter(session, attempt) {
  return (
    attempt.permission === "writer" ||
    (attempt.permission === undefined &&
      session.managed.workUnits?.[attempt.workUnitId]?.permission === "writer")
  );
}

function managedAttemptIsWriter(managed, attempt) {
  return (
    attempt.permission === "writer" ||
    (attempt.permission === undefined &&
      managed.workUnits?.[attempt.workUnitId]?.permission === "writer")
  );
}

function attemptPermission(session, identity, payload, workUnit) {
  if (!session.managed.workUnits && payload.permission === undefined) return undefined;
  if (!["read-only", "writer"].includes(payload.permission)) {
    throw new ControllerError(
      "invalid_attempt_permission",
      "open exige permission read-only o writer para cada intento planificado.",
      2,
    );
  }
  const readOnlyRoles = new Set(["evaluador", "explorador", "planificador"]);
  if (readOnlyRoles.has(identity.role) && payload.permission !== "read-only") {
    throw new ControllerError("invalid_attempt_permission", `${identity.role} debe ser read-only.`, 2);
  }
  if (identity.role === "implementador" && payload.permission !== "writer") {
    throw new ControllerError("invalid_attempt_permission", "El Implementador debe ser writer.", 2);
  }
  if (payload.permission === "writer" && workUnit && workUnit.permission !== "writer") {
    throw new ControllerError(
      "invalid_attempt_permission",
      "El intento writer no tiene ownership de escritura en la unidad.",
      2,
    );
  }
  return payload.permission;
}

function attemptTrace(session, payload, workUnit) {
  if (!session.managed.workUnits) return {};
  if (typeof payload.baseRevision !== "string" || !payload.baseRevision.trim()) {
    throw new ControllerError("base_revision_required", "open exige baseRevision no vacía.", 2);
  }
  if (typeof payload.threadId !== "string" || !payload.threadId.trim()) {
    throw new ControllerError("thread_id_required", "open exige threadId no vacío.", 2);
  }
  if (
    !Array.isArray(payload.criteria) ||
    !payload.criteria.length ||
    payload.criteria.some((criterion) => typeof criterion !== "string" || !criterion.trim()) ||
    new Set(payload.criteria).size !== payload.criteria.length
  ) {
    throw new ControllerError("invalid_attempt_criteria", "open exige criteria trazables.", 2);
  }
  const criteria = payload.criteria.map((criterion) => criterion.trim());
  if (workUnit && criteria.some((criterion) => !workUnit.acceptanceCriteria.includes(criterion))) {
    throw new ControllerError(
      "invalid_attempt_criteria",
      "criteria debe pertenecer a la unidad asignada.",
      2,
    );
  }
  return {
    baseRevision: payload.baseRevision.trim(),
    criteria,
    threadId: payload.threadId.trim(),
    ...(workUnit ? { wave: workUnit.wave } : {}),
  };
}

function assertAgentCapacity(session, identity, permission) {
  const active = activeAttempts(session.managed);
  const mode = session.managed.mode ?? "full";
  const limits = MODE_LIMITS[mode];
  const activeForRole = active.filter((attempt) => attempt.role === identity.role).length;
  if (activeForRole >= (limits.roles[identity.role] ?? 1)) {
    throw new ControllerError(
      "role_capacity_reached",
      `El rol ${identity.role} alcanzó el tope del modo ${mode}.`,
    );
  }
  const totalLimit = technicalAgentCapacity(session.managed);
  if (active.length >= totalLimit) {
    throw new ControllerError(
      "agent_capacity_reached",
      "La capacidad efectiva de subagentes está ocupada.",
    );
  }
  if (
    permission === "read-only" &&
    active.filter((attempt) => attempt.permission === "read-only").length >=
      readOnlyAgentCapacity(session.managed)
  ) {
    throw new ControllerError(
      "agent_capacity_reached",
      "La capacidad de contextos read-only está ocupada.",
    );
  }
  if (
    permission === "writer" &&
    active.filter((attempt) => managedAttemptIsWriter(session.managed, attempt)).length >=
      (session.managed.writerIsolationCapacity ?? session.managed.isolationCapacity ?? 1)
  ) {
    throw new ControllerError("writer_conflict", "Ya existe un escritor activo en el working tree.");
  }
}

function assertWorkUnitCanOpen(session, identity, payload, workUnit, permission) {
  if (!workUnit) return;
  if (permission === "writer") {
    const activeWriter = activeAttempts(session.managed).find(
      (attempt) => attempt.permission === "writer",
    );
    if (activeWriter) {
      throw new ControllerError("writer_conflict", "Ya existe un escritor activo en el working tree.");
    }
  }
  if (identity.role === "implementador") {
    if (workUnit.validated && (typeof payload.impact !== "string" || !payload.impact.trim())) {
      throw new ControllerError(
        "work_unit_already_validated",
        "Una unidad validada solo puede repetirse con impacto demostrado.",
      );
    }
    if (workUnit.dependsOn.some((dependency) => !session.managed.workUnits[dependency].validated)) {
      throw new ControllerError(
        "dependencies_not_validated",
        "La unidad conserva dependencias sin validación atribuible.",
      );
    }
    if (!["planned", "failed", "consolidated"].includes(workUnit.state)) {
      throw new ControllerError("invalid_work_unit_transition", `La unidad está en estado ${workUnit.state}.`);
    }
  }
  if (identity.role === "tester" && workUnit.state !== "implemented") {
    throw new ControllerError(
      "work_unit_not_implemented",
      "El Tester solo puede validar una unidad implementada.",
    );
  }
}

function requiredEvaluationAxes(managed) {
  const strategy =
    managed.evaluationStrategy ?? (managed.mode === "light" ? "combined" : "dual");
  return strategy === "dual" ? ["standards", "specification"] : ["combined"];
}

function currentEvaluationGeneration(managed) {
  return managed.evaluationGeneration ?? 1;
}

function evaluationAttemptIsCurrent(managed, attempt) {
  return (
    !attempt.evaluationAxis ||
    (attempt.evaluationGeneration ?? 1) === currentEvaluationGeneration(managed)
  );
}

function currentEvaluation(managed, axis) {
  const evaluation = managed.evaluations?.[axis];
  return evaluation &&
    (evaluation.generation ?? 1) === currentEvaluationGeneration(managed)
    ? evaluation
    : undefined;
}

function assertEvaluationCanOpen(session, identity, payload) {
  if (identity.role !== "evaluador" || !session.managed.workUnits) return;
  if (!workUnitStatus(session.managed).fanInReady) {
    throw new ControllerError("fan_in_pending", "La evaluación final exige fan-in de unidades validadas.");
  }
  if (!requiredEvaluationAxes(session.managed).includes(payload.evaluationAxis)) {
    throw new ControllerError(
      "invalid_evaluation_axis",
      "evaluationAxis no corresponde al modo de la DevSession.",
      2,
    );
  }
  const existing = Object.values(session.managed.attempts).find(
    (attempt) =>
      attempt.phaseId === identity.phaseId &&
      attempt.evaluationAxis === payload.evaluationAxis &&
      (attempt.evaluationGeneration ?? 1) === currentEvaluationGeneration(session.managed) &&
      (["active", "awaiting_input"].includes(attempt.state) ||
        (attempt.state === "completed" &&
          currentEvaluation(session.managed, payload.evaluationAxis)?.state === "approved")),
  );
  if (existing) {
    throw new ControllerError(
      "evaluation_axis_conflict",
      `El eje ${payload.evaluationAxis} ya tiene un intento vigente.`,
    );
  }
}

function advanceWorkUnitOnOpen(session, identity, workUnit, payload, attempt) {
  if (!workUnit) return;
  if (identity.role === "implementador") {
    if (workUnit.validated) {
      workUnit.validated = false;
      workUnit.impact = payload.impact.trim();
      session.managed.evaluationGeneration = currentEvaluationGeneration(session.managed) + 1;
      session.managed.evaluations = {};
    }
    workUnit.implementationAttempt = attempt;
    workUnit.state = "active";
  }
  if (identity.role === "tester") {
    workUnit.state = "validating";
    workUnit.testingAttempt = attempt;
  }
}

function testerReportPassed(report) {
  return /^(?:Ningun[oa]|No aplica)\.?$/i.test(testerFailure(report));
}

function testerFailure(report) {
  return report.match(/^- \*\*Fallos:\*\*\s*(.+)$/m)?.[1].trim() ?? "No informado";
}

function advanceWorkUnitOnCommit(session, ledger, attempt, report) {
  const workUnit = session.managed.workUnits?.[ledger.workUnitId];
  if (!workUnit) return;
  if (ledger.role === "implementador") {
    workUnit.implementationEvidence = ledger.evidence;
    workUnit.implementationAttempt = attempt;
    workUnit.state = "implemented";
  }
  if (ledger.role === "tester") {
    workUnit.testingAttempt = attempt;
    if (testerReportPassed(report)) {
      workUnit.consolidatedAttempt = attempt;
      workUnit.state = "consolidated";
      workUnit.validated = true;
      workUnit.validationAttempt = attempt;
      workUnit.validationEvidence = ledger.evidence;
    } else {
      workUnit.failureAttempt = attempt;
      workUnit.failureCause = testerFailure(report);
      workUnit.failureEvidence = ledger.evidence;
      workUnit.state = "failed";
      workUnit.validated = false;
    }
  }
}

function advanceEvaluationOnCommit(session, ledger, attempt, report) {
  if (!ledger.evaluationAxis || !evaluationAttemptIsCurrent(session.managed, ledger)) return;
  const approved = /^- \*\*Veredicto:\*\*\s*aprobado\.?$/m.test(report);
  session.managed.evaluations ??= {};
  session.managed.evaluations[ledger.evaluationAxis] = {
    attempt,
    generation: ledger.evaluationGeneration ?? currentEvaluationGeneration(session.managed),
    state: approved ? "approved" : "changes_required",
  };
}

function advanceUnitOnFail(session, ledger, attempt, cause) {
  const workUnit = session.managed.workUnits?.[ledger.workUnitId];
  if (workUnit && ledger.role === "implementador") workUnit.state = "failed";
  if (workUnit && ledger.role === "tester") {
    workUnit.failureAttempt = attempt;
    workUnit.failureCause = cause;
    workUnit.failureEvidence = { outcome: "failed" };
    workUnit.state = "failed";
    workUnit.validated = false;
  }
  if (ledger.evaluationAxis) {
    if (!evaluationAttemptIsCurrent(session.managed, ledger)) return;
    session.managed.evaluations ??= {};
    session.managed.evaluations[ledger.evaluationAxis] = {
      attempt,
      generation: ledger.evaluationGeneration ?? currentEvaluationGeneration(session.managed),
      state: "changes_required",
    };
  }
}

function workUnitStatus(managed) {
  if (!managed.workUnits) return {};
  const workUnits = Object.values(managed.workUnits)
    .sort((left, right) => left.workUnitId.localeCompare(right.workUnitId))
    .map((unit) => ({
      ...unit,
      ready:
        !unit.validated &&
        ["planned", "failed"].includes(unit.state) &&
        unit.dependsOn.every((dependency) => managed.workUnits[dependency].validated),
    }));
  const readyReadOnly = workUnits.filter(
    (unit) => unit.ready && unit.permission === "read-only",
  ).length;
  const readyWriters = workUnits.filter(
    (unit) => unit.ready && unit.permission === "writer",
  ).length;
  const agentCapacity = technicalAgentCapacity(managed);
  const readOnlyCapacity = readOnlyAgentCapacity(managed);
  const fanInReady = workUnits.every((unit) => unit.validated && unit.state === "consolidated");
  const active = activeAttempts(managed);
  const activeReadOnly = active.filter((attempt) => attempt.permission === "read-only").length;
  const activeWriters = active.filter((attempt) => managedAttemptIsWriter(managed, attempt)).length;
  const activeEvaluators = active.filter((attempt) => attempt.role === "evaluador").length;
  const activeAxes = new Set(
    active
      .filter(
        (attempt) =>
          attempt.evaluationAxis &&
          (attempt.evaluationGeneration ?? 1) === currentEvaluationGeneration(managed),
      )
      .map((attempt) => attempt.evaluationAxis),
  );
  const pendingAxes = requiredEvaluationAxes(managed).filter(
    (axis) => currentEvaluation(managed, axis)?.state !== "approved" && !activeAxes.has(axis),
  );
  const availableAgents = Math.max(0, agentCapacity - active.length);
  const availableReadOnly = Math.max(0, readOnlyCapacity - activeReadOnly);
  const writerIsolationCapacity =
    managed.writerIsolationCapacity ?? managed.isolationCapacity ?? 1;
  const availableWriters = Math.max(0, writerIsolationCapacity - activeWriters);
  const evaluationCapacity = fanInReady
    ? Math.min(
        availableAgents,
        availableReadOnly,
        Math.max(0, MODE_LIMITS[managed.mode ?? "full"].roles.evaluador - activeEvaluators),
        pendingAxes.length,
      )
    : 0;
  const implementationCapacity = Math.min(
    availableAgents,
    Math.min(availableReadOnly, readyReadOnly) + Math.min(availableWriters, readyWriters),
  );
  return {
    agentCapacity,
    effectiveCapacity: Math.max(evaluationCapacity, implementationCapacity),
    evaluationCapacity,
    fanInReady,
    implementationCapacity,
    readOnlyCapacity,
    writerIsolationCapacity,
    workUnits,
  };
}

function finalEvaluationStatus(managed) {
  if (!managed.workUnits) return {};
  const requiredAxes = requiredEvaluationAxes(managed);
  const strategy = requiredAxes.length === 1 ? "combined" : "dual";
  const risk =
    strategy === "dual"
      ? (managed.evaluationRisk ??
        (!Object.hasOwn(managed, "evaluationStrategy") ? "legacy-full-mode" : undefined))
      : undefined;
  const axes = Object.fromEntries(
    requiredAxes.map((axis) => [axis, currentEvaluation(managed, axis)?.state ?? "pending"]),
  );
  return {
    finalEvaluation: {
      approved: requiredAxes.every((axis) => axes[axis] === "approved"),
      axes,
      generation: currentEvaluationGeneration(managed),
      ...(risk !== undefined ? { risk } : {}),
      requiredAxes,
      strategy,
    },
  };
}

async function commandInit(options, payload) {
  const session = await readGlobal(options, false);
  const legacy = session.exists && !session.managed;
  if (session.managed) {
    validateGlobal(session.managed, options.session);
    assertRevision(options.expectedRevision, session.managed.revision);
    if (payload.workUnits !== undefined) {
      if (payload.workflow !== session.managed.workflow) {
        throw new ControllerError("invalid_workflow", "El plan contradice el workflow de la sesión.", 2);
      }
      const configured = parseWorkUnits(payload, session.managed);
      if (session.managed.workUnits) {
        if (
          stableJson(workUnitPlanDefinition(session.managed, configured)) !==
          stableJson(workUnitPlanDefinition(configured))
        ) {
          throw new ControllerError("divergent_work_units", "La DevSession ya tiene otro plan de unidades.");
        }
        if (completeWorkUnitPlan(session.managed, configured)) {
          if (session.managed.closed) {
            throw new ControllerError("session_closed", "La DevSession ya está cerrada.");
          }
          session.managed.revision += 1;
          await atomicWrite(session.global, withManaged(session.human, session.managed));
          return {
            command: "init",
            configured: true,
            legacy: false,
            revision: session.managed.revision,
            session: options.session,
            state: "active",
          };
        }
      } else {
        if (session.managed.closed) {
          throw new ControllerError("session_closed", "La DevSession ya está cerrada.");
        }
        Object.assign(session.managed, configured);
        session.managed.revision += 1;
        await atomicWrite(session.global, withManaged(session.human, session.managed));
        return {
          command: "init",
          configured: true,
          legacy: false,
          revision: session.managed.revision,
          session: options.session,
          state: "active",
        };
      }
    }
    return {
      command: "init",
      legacy: false,
      revision: session.managed.revision,
      session: options.session,
      state: session.managed.closed ? "completed" : "active",
    };
  }
  assertRevision(options.expectedRevision, 0);
  const workflow = payload.workflow;
  if (!["architecture", "bugfix", "feature", "refactor"].includes(workflow)) {
    throw new ControllerError("invalid_workflow", "init exige un workflow canónico.", 2);
  }
  let human = session.human;
  if (!session.exists) {
    const templatePath = join(options.root, ".agents", "templates", "dev-session.md");
    human = renderGlobalTemplate(await readUtf8(templatePath), {
      ...payload,
      session: options.session,
      workflow,
    });
  }
  const managed = {
    attempts: {},
    closed: false,
    kind: "global",
    revision: 1,
    sessionSlug: options.session,
    version: 1,
    workflow,
    ...capacityConfig(payload),
    ...parseWorkUnits(payload),
  };
  await mkdir(session.sessions, { recursive: true });
  await atomicWrite(session.global, withManaged(human, managed));
  return { command: "init", legacy, revision: 1, session: options.session, state: "active" };
}

function parsePhases(source) {
  const phases = new Map();
  for (const match of source.matchAll(/<!-- agentic-phase:v1 (\{[^\n]+\}) -->/g)) {
    let phase;
    try {
      phase = JSON.parse(match[1]);
    } catch {
      throw new ControllerError("invalid_phase_contract", "El workflow contiene un marcador de fase inválido.");
    }
    if (!phase.id || !phase.role || phases.has(phase.id)) {
      throw new ControllerError("invalid_phase_contract", "El workflow contiene fases ambiguas.");
    }
    phases.set(phase.id, phase.role);
  }
  if (!phases.size) throw new ControllerError("invalid_phase_contract", "El workflow no declara fases.");
  return phases;
}

function parseRoleContract(source) {
  const output = source.match(/^## Salida\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1];
  if (!output) throw new ControllerError("invalid_role_contract", "El rol no declara ## Salida.");
  const labels = [...output.matchAll(/^- \*\*([^*]+?):\*\*/gm)].map((match) =>
    match[1].trim().replace(/[.]$/, ""),
  );
  if (!labels.length || new Set(labels).size !== labels.length) {
    throw new ControllerError("invalid_role_contract", "El contrato de salida no es interpretable.");
  }
  return labels;
}

function parseAttempt(identity) {
  const match = identity?.match(ATTEMPT_PATTERN);
  if (!match) throw new ControllerError("invalid_attempt", "--attempt no respeta la identidad canónica.", 2);
  return { attempt: Number(match[3]), phaseId: match[1], role: match[2] };
}

function renderSubdevTemplate(template, values) {
  let rendered = template
    .replaceAll("<session-slug>", values.session)
    .replaceAll("<attempt-id>", values.identity)
    .replaceAll("<phase-id>", values.phaseId)
    .replaceAll("<role>", values.role)
    .replaceAll("<attempt-number>", String(values.attempt))
    .replaceAll("<work-unit-id>", values.workUnitId ?? "No aplica")
    .replaceAll("<wave>", String(values.wave ?? "No aplica"))
    .replaceAll("<permission>", values.permission ?? "No aplica")
    .replaceAll("<base-revision>", String(values.baseRevision ?? "No aplica"))
    .replaceAll("<thread-id>", values.threadId ?? "No aplica")
    .replace("<objective>", values.objective ?? "Pendiente")
    .replace("<rules>", values.rules ?? "- Según la DevSession global.")
    .replace("<tasks>", values.tasks ?? "- Según la DevSession global.")
    .replace("<findings>", values.findings ?? "- No aplica")
    .replace("<contract>", values.contract.map((label) => `- **${label}:**`).join("\n"));
  if (values.previousAttempt) {
    rendered = rendered.replace(
      "## Hallazgos o revisiones pendientes de intentos anteriores\n\n",
      `## Hallazgos o revisiones pendientes de intentos anteriores\n\n- Intento anterior: \`${values.previousAttempt}\`\n- Causa: ${values.cause}\n\n`,
    );
  }
  return rendered;
}

async function commandOpen(options, payload) {
  const session = await readGlobal(options);
  if (!session.managed) throw new ControllerError("legacy_requires_init", "La sesión legacy debe adoptarse con init.");
  validateGlobal(session.managed, options.session);
  assertRevision(options.expectedRevision, session.managed.revision);
  if (session.managed.closed) throw new ControllerError("session_closed", "La DevSession ya está cerrada.");
  assertWorkUnitPlanReady(session.managed);

  const identity = parseAttempt(options.attempt);
  if (payload.phaseId !== identity.phaseId || payload.role !== identity.role) {
    throw new ControllerError("attempt_identity_conflict", "El payload contradice la identidad del intento.");
  }
  const workflowPath = join(options.root, ".agents", "workflows", `${session.managed.workflow}.md`);
  const phases = parsePhases(await readUtf8(workflowPath));
  if (phases.get(identity.phaseId) !== identity.role) {
    throw new ControllerError("attempt_identity_conflict", "La fase y el rol contradicen el workflow.");
  }
  let workUnit;
  if (session.managed.workUnits && ["implementador", "tester"].includes(identity.role)) {
    if (!WORK_UNIT_PATTERN.test(payload.workUnitId ?? "")) {
      throw new ControllerError("work_unit_required", "open exige workUnitId para una sesión por unidades.", 2);
    }
    workUnit = session.managed.workUnits[payload.workUnitId];
    if (!workUnit) {
      throw new ControllerError("work_unit_not_found", "workUnitId no pertenece a la DevSession.", 2);
    }
  } else if (payload.workUnitId !== undefined && session.managed.workUnits) {
    workUnit = session.managed.workUnits[payload.workUnitId];
    if (!workUnit) {
      throw new ControllerError("work_unit_not_found", "workUnitId no pertenece a la DevSession.", 2);
    }
  } else if (payload.workUnitId !== undefined) {
    throw new ControllerError("work_unit_not_found", "La DevSession v1 no declara unidades.", 2);
  }
  if (payload.laneId !== undefined && !WORK_UNIT_PATTERN.test(payload.laneId)) {
    throw new ControllerError("invalid_lane_id", "laneId debe ser canónico.", 2);
  }
  const permission = attemptPermission(session, identity, payload, workUnit);
  const trace = attemptTrace(session, payload, workUnit);
  const openPayloadHash = hashText(stableJson(payload));
  const existingLedger = session.managed.attempts[options.attempt];
  if (existingLedger) {
    const existingEnvelope = await readEnvelope(session, options);
    if (
      existingLedger.openPayloadHash !== openPayloadHash ||
      existingEnvelope.managed.openPayloadHash !== openPayloadHash
    ) {
      throw new ControllerError("divergent_open", "El intento ya se abrió con otro payload.");
    }
    assertAttemptState(existingLedger, existingEnvelope, ["active"]);
    return {
      attempt: options.attempt,
      command: "open",
      revision: session.managed.revision,
      session: options.session,
      state: "active",
    };
  }
  assertEvaluationCanOpen(session, identity, payload);
  assertWorkUnitCanOpen(session, identity, payload, workUnit, permission);
  const phasePrior = Object.values(session.managed.attempts).filter(
    (attempt) => attempt.phaseId === identity.phaseId,
  );
  const prior = phasePrior.filter((attempt) => relatedAttempt(attempt, payload));
  const expectedAttempt = Math.max(0, ...phasePrior.map((attempt) => attempt.attempt)) + 1;
  if (identity.attempt !== expectedAttempt || session.managed.attempts[options.attempt]) {
    throw new ControllerError("attempt_not_monotonic", "El número de intento no es monotónico.");
  }
  let reworkTrace = {};
  if (prior.length) {
    if (typeof payload.cause !== "string" || !payload.cause.trim()) {
      throw new ControllerError(
        "invalid_rework_cause",
        "Todo retrabajo exige cause no vacía.",
        2,
      );
    }
    if (typeof payload.previousAttempt !== "string") {
      throw new ControllerError(
        "invalid_previous_attempt",
        "Todo retrabajo exige previousAttempt canónico.",
        2,
      );
    }
    const previousIdentity = parseAttempt(payload.previousAttempt);
    const latestPrior = prior.reduce((latest, attempt) =>
      attempt.attempt > latest.attempt ? attempt : latest,
    );
    const latestPriorIdentity = Object.entries(session.managed.attempts).find(
      ([, attempt]) => attempt === latestPrior,
    )?.[0];
    if (
      previousIdentity.phaseId !== identity.phaseId ||
      previousIdentity.role !== identity.role ||
      payload.previousAttempt !== latestPriorIdentity ||
      session.managed.attempts[payload.previousAttempt] !== latestPrior ||
      !["completed", "failed"].includes(latestPrior.state)
    ) {
      throw new ControllerError(
        "previous_attempt_conflict",
        "previousAttempt no identifica el último intento terminal de la fase.",
      );
    }
    reworkTrace = { cause: payload.cause.trim(), previousAttempt: payload.previousAttempt };
  } else if (payload.cause !== undefined || payload.previousAttempt !== undefined) {
    throw new ControllerError(
      "unexpected_rework_trace",
      "El primer intento no admite trazabilidad de retrabajo.",
      2,
    );
  }
  assertAgentCapacity(session, identity, permission);
  const rolePath = join(options.root, ".agents", "roles", `${identity.role}.md`);
  const contract = parseRoleContract(await readUtf8(rolePath));
  const templatePath = join(options.root, ".agents", "templates", "subdev-session.md");
  const human = renderSubdevTemplate(await readUtf8(templatePath), {
    ...identity,
    ...payload,
    ...reworkTrace,
    ...trace,
    contract,
    identity: options.attempt,
    permission,
    session: options.session,
    wave: workUnit?.wave,
  });
  const envelopeManaged = {
    attempt: identity.attempt,
    contract,
    ...reworkTrace,
    kind: "subdev",
    openPayloadHash,
    phaseId: identity.phaseId,
    revision: 1,
    role: identity.role,
    ...(permission !== undefined ? { permission } : {}),
    ...trace,
    sessionSlug: options.session,
    state: "active",
    version: 1,
    ...(workUnit ? { workUnitId: workUnit.workUnitId } : {}),
    ...(payload.laneId !== undefined ? { laneId: payload.laneId } : {}),
    ...(payload.evaluationAxis !== undefined ? { evaluationAxis: payload.evaluationAxis } : {}),
    ...(payload.evaluationAxis !== undefined
      ? { evaluationGeneration: currentEvaluationGeneration(session.managed) }
      : {}),
  };
  const envelopePath = join(session.subdirectory, `${options.attempt}.md`);
  const envelopeSource = withManaged(human, envelopeManaged);
  if (existsSync(envelopePath)) {
    if ((await readUtf8(envelopePath)) !== envelopeSource) {
      throw new ControllerError("attempt_collision", "La ruta del intento ya existe.");
    }
  } else {
    await mkdir(dirname(envelopePath), { recursive: true });
    await atomicWrite(envelopePath, envelopeSource);
  }
  if (permission === "writer") await acquireWriterReservation(options);
  session.managed.attempts[options.attempt] = {
    attempt: identity.attempt,
    ...reworkTrace,
    openPayloadHash,
    phaseId: identity.phaseId,
    role: identity.role,
    ...(permission !== undefined ? { permission } : {}),
    ...trace,
    state: "active",
    ...(workUnit ? { workUnitId: workUnit.workUnitId } : {}),
    ...(payload.laneId !== undefined ? { laneId: payload.laneId } : {}),
    ...(payload.evaluationAxis !== undefined ? { evaluationAxis: payload.evaluationAxis } : {}),
    ...(payload.evaluationAxis !== undefined
      ? { evaluationGeneration: currentEvaluationGeneration(session.managed) }
      : {}),
  };
  advanceWorkUnitOnOpen(session, identity, workUnit, payload, options.attempt);
  session.managed.currentPhase = identity.phaseId;
  session.managed.revision += 1;
  await atomicWrite(session.global, withManaged(session.human, session.managed));
  return {
    attempt: options.attempt,
    command: "open",
    revision: session.managed.revision,
    session: options.session,
    state: "active",
  };
}

async function readEnvelope(session, options) {
  const identity = parseAttempt(options.attempt);
  const path = join(session.subdirectory, `${options.attempt}.md`);
  if (!existsSync(path)) throw new ControllerError("attempt_not_found", "La SubDevSession no existe.");
  const source = await readUtf8(path);
  const envelope = { path, source, ...splitManaged(source, path) };
  const managed = envelope.managed;
  if (
    !managed ||
    managed.kind !== "subdev" ||
    managed.sessionSlug !== options.session ||
    managed.phaseId !== identity.phaseId ||
    managed.role !== identity.role ||
    managed.attempt !== identity.attempt
  ) {
    throw new ControllerError(
      "attempt_identity_conflict",
      "La identidad administrada del intento contradice la ruta.",
    );
  }
  return envelope;
}

function updateEnvelopeStatus(human, state) {
  if (!/^- Estado: `[^`]+`$/m.test(human)) {
    throw new ControllerError("ambiguous_envelope", "La SubDevSession no declara un estado humano único.");
  }
  return human.replace(/^- Estado: `[^`]+`$/m, `- Estado: \`${state}\``);
}

function hasEnvelopeStatus(human, state) {
  const statuses = [...human.matchAll(/^- Estado: `([^`]+)`$/gm)];
  return statuses.length === 1 && statuses[0][1] === state;
}

function ledgerAttempt(session, options) {
  const attempt = session.managed.attempts[options.attempt];
  if (!attempt) throw new ControllerError("attempt_not_found", "El ledger no contiene el intento.");
  return attempt;
}

function assertAttemptState(ledger, envelope, expected) {
  if (ledger.state !== envelope.managed.state) {
    throw new ControllerError("attempt_state_conflict", "El ledger y la SubDevSession discrepan.");
  }
  if (!expected.includes(ledger.state)) {
    throw new ControllerError("invalid_transition", `El intento está en estado ${ledger.state}.`);
  }
}

async function commandAwaitInput(options, payload) {
  const session = await readGlobal(options);
  if (!session.managed) throw new ControllerError("legacy_requires_init", "La sesión legacy debe adoptarse con init.");
  validateGlobal(session.managed, options.session);
  assertRevision(options.expectedRevision, session.managed.revision);
  const envelope = await readEnvelope(session, options);
  const ledger = ledgerAttempt(session, options);
  if (typeof payload.request !== "string" || !payload.request.trim()) {
    throw new ControllerError("invalid_request", "await-input exige request no vacío.", 2);
  }

  const waitingGlobalHash = hashText(session.human);
  if (ledger.state === "awaiting_input" && envelope.managed.state === "awaiting_input") {
    if (envelope.managed.request !== payload.request) {
      throw new ControllerError(
        "divergent_request",
        "El intento ya espera una solicitud diferente.",
      );
    }
    if (
      envelope.managed.waitingGlobalHash !== ledger.waitingGlobalHash ||
      !hasEnvelopeStatus(envelope.human, "awaiting_input")
    ) {
      throw new ControllerError(
        "ambiguous_checkpoint",
        "El estado confirmado de await-input es inconsistente.",
      );
    }
    return {
      attempt: options.attempt,
      command: "await-input",
      revision: session.managed.revision,
      session: options.session,
      state: "awaiting_input",
    };
  }
  if (ledger.state === "active" && envelope.managed.state === "awaiting_input") {
    if (
      envelope.managed.request !== payload.request ||
      envelope.managed.waitingGlobalHash !== waitingGlobalHash ||
      !hasEnvelopeStatus(envelope.human, "awaiting_input")
    ) {
      throw new ControllerError(
        "ambiguous_checkpoint",
        "El checkpoint de await-input no puede completarse sin intervención.",
      );
    }
    ledger.state = "awaiting_input";
    ledger.waitingGlobalHash = waitingGlobalHash;
    session.managed.revision += 1;
    await atomicWrite(session.global, withManaged(session.human, session.managed));
    return {
      attempt: options.attempt,
      command: "await-input",
      revision: session.managed.revision,
      session: options.session,
      state: "awaiting_input",
    };
  }
  assertAttemptState(ledger, envelope, ["active"]);
  envelope.managed.request = payload.request;
  envelope.managed.revision += 1;
  envelope.managed.state = "awaiting_input";
  envelope.managed.waitingGlobalHash = waitingGlobalHash;
  ledger.state = "awaiting_input";
  ledger.waitingGlobalHash = waitingGlobalHash;
  session.managed.revision += 1;
  await atomicWrite(
    envelope.path,
    withManaged(updateEnvelopeStatus(envelope.human, "awaiting_input"), envelope.managed),
  );
  await atomicWrite(session.global, withManaged(session.human, session.managed));
  return {
    attempt: options.attempt,
    command: "await-input",
    revision: session.managed.revision,
    session: options.session,
    state: "awaiting_input",
  };
}

async function commandResume(options, payload) {
  const session = await readGlobal(options);
  if (!session.managed) throw new ControllerError("legacy_requires_init", "La sesión legacy debe adoptarse con init.");
  validateGlobal(session.managed, options.session);
  assertRevision(options.expectedRevision, session.managed.revision);
  const envelope = await readEnvelope(session, options);
  const ledger = ledgerAttempt(session, options);
  const resumedGlobalHash = hashText(session.human);
  const resumeContext = payload.context ?? "Registrado en la DevSession global.";
  if (
    ledger.state === "active" &&
    envelope.managed.state === "active" &&
    ledger.resumedGlobalHash
  ) {
    if (envelope.managed.resumeContext !== resumeContext) {
      throw new ControllerError(
        "divergent_resume",
        "El intento ya se reanudó con otro contexto.",
      );
    }
    if (
      envelope.managed.resumedGlobalHash !== ledger.resumedGlobalHash ||
      !hasEnvelopeStatus(envelope.human, "active")
    ) {
      throw new ControllerError(
        "ambiguous_checkpoint",
        "El estado confirmado de resume es inconsistente.",
      );
    }
    return {
      attempt: options.attempt,
      command: "resume",
      revision: session.managed.revision,
      session: options.session,
      state: "active",
    };
  }
  if (resumedGlobalHash === ledger.waitingGlobalHash) {
    throw new ControllerError(
      "global_context_unchanged",
      "La DevSession global no cambió desde await-input.",
    );
  }

  if (ledger.state === "awaiting_input" && envelope.managed.state === "active") {
    if (
      envelope.managed.resumeContext !== resumeContext ||
      envelope.managed.resumedGlobalHash !== resumedGlobalHash ||
      !hasEnvelopeStatus(envelope.human, "active")
    ) {
      throw new ControllerError(
        "ambiguous_checkpoint",
        "El checkpoint de resume no puede completarse sin intervención.",
      );
    }
    ledger.state = "active";
    ledger.resumedGlobalHash = resumedGlobalHash;
    session.managed.revision += 1;
    await atomicWrite(session.global, withManaged(session.human, session.managed));
    return {
      attempt: options.attempt,
      command: "resume",
      revision: session.managed.revision,
      session: options.session,
      state: "active",
    };
  }
  assertAttemptState(ledger, envelope, ["awaiting_input"]);
  envelope.managed.resumeContext = resumeContext;
  envelope.managed.resumedGlobalHash = resumedGlobalHash;
  envelope.managed.revision += 1;
  envelope.managed.state = "active";
  ledger.state = "active";
  ledger.resumedGlobalHash = resumedGlobalHash;
  session.managed.revision += 1;
  await atomicWrite(
    envelope.path,
    withManaged(updateEnvelopeStatus(envelope.human, "active"), envelope.managed),
  );
  await atomicWrite(session.global, withManaged(session.human, session.managed));
  return {
    attempt: options.attempt,
    command: "resume",
    revision: session.managed.revision,
    session: options.session,
    state: "active",
  };
}

function parseReport(report, contract) {
  if (typeof report !== "string") {
    throw new ControllerError("incomplete_report", "commit exige un reporte textual completo.");
  }
  normalizedText(report);
  const fields = [...report.matchAll(/^- \*\*([^*]+?):\*\*\s*(.*)$/gm)].map((match) => ({
    label: match[1].trim().replace(/[.]$/, ""),
    value: match[2].trim(),
  }));
  if (
    fields.length !== contract.length ||
    fields.some((field, index) => field.label !== contract[index] || !field.value)
  ) {
    throw new ControllerError(
      "incomplete_report",
      "El reporte no satisface las etiquetas y el orden de ## Salida.",
    );
  }
  return normalizedText(report);
}

function roleTitle(role) {
  return role[0].toUpperCase() + role.slice(1);
}

function consolidationSection(options, envelope, { hash, result, state, suffix = "" }) {
  const scope = [
    ...(envelope.managed.workUnitId
      ? [`unidad: \`${envelope.managed.workUnitId}\``]
      : []),
    ...(envelope.managed.evaluationAxis
      ? [`eje: \`${envelope.managed.evaluationAxis}\``]
      : []),
  ];
  const reference = [
    `Sesión: \`${options.session}\``,
    `intento: \`${options.attempt}\``,
    `fase: \`${envelope.managed.phaseId}\``,
    `rol: \`${envelope.managed.role}\``,
    ...scope,
    `estado: \`${state}\``,
    `resultado: \`${result}\``,
    `hash: \`${hash}\``,
    `reporte: \`.agents/sessions/${options.session}/${options.attempt}.md\``,
  ].join("; ");
  return `### ${roleTitle(envelope.managed.role)} ${envelope.managed.phaseId} — intento ${envelope.managed.attempt}${suffix}\n\n- ${reference}.\n`;
}

function insertConsolidation(human, section) {
  const indexHeading = "## Índice compacto de reportes";
  const indexAt = human.indexOf(indexHeading);
  if (indexAt >= 0) {
    const nextHeadingAt = human.indexOf("\n## ", indexAt + indexHeading.length);
    if (nextHeadingAt < 0) return `${human.replace(/\n+$/, "")}\n\n${section}`;
    return `${human.slice(0, nextHeadingAt).replace(/\n+$/, "")}\n\n${section}\n${human.slice(nextHeadingAt + 1)}`;
  }
  const heading = "## Control de consolidación";
  const at = human.indexOf(heading);
  if (at >= 0) return `${human.slice(0, at).replace(/\n+$/, "")}\n\n${section}\n${human.slice(at)}`;
  return `${human.replace(/\n+$/, "")}\n\n${section}`;
}

function failureSection(options, envelope, ackHash) {
  return consolidationSection(options, envelope, {
    hash: ackHash,
    result: "fallo-sin-reporte",
    state: "failed",
    suffix: ", fallo sin reporte",
  });
}

function insertReport(human, report) {
  const pattern = /(## Reporte contractual producido\n\n)([\s\S]*?)(?=\n## Estado de consolidación)/;
  if (!pattern.test(human)) {
    throw new ControllerError("ambiguous_envelope", "La SubDevSession no contiene el seam del reporte.");
  }
  return human.replace(pattern, `$1${report}\n`);
}

function updateConsolidationStatus(human, state) {
  const pattern = /(## Estado de consolidación en la DevSession global\n\n)- `[^`]+`/;
  if (!pattern.test(human)) {
    throw new ControllerError("ambiguous_envelope", "La SubDevSession no contiene el estado de consolidación.");
  }
  return human.replace(pattern, `$1- \`${state}\``);
}

function commitResult(options, session, ledger, idempotent = false) {
  return {
    ackHash: ledger.ackHash,
    attempt: options.attempt,
    command: "commit",
    ...(idempotent ? { idempotent: true } : {}),
    reportHash: ledger.reportHash,
    revision: session.managed.revision,
    session: options.session,
    state: "completed",
  };
}

async function commandCommit(options, payload) {
  const session = await readGlobal(options);
  if (!session.managed) throw new ControllerError("legacy_requires_init", "La sesión legacy debe adoptarse con init.");
  validateGlobal(session.managed, options.session);
  assertRevision(options.expectedRevision, session.managed.revision);
  const envelope = await readEnvelope(session, options);
  const ledger = ledgerAttempt(session, options);
  const report = parseReport(payload.report, envelope.managed.contract);
  const reportHash = hashText(report);
  if (ledger.state === "completed") {
    if (ledger.reportHash !== reportHash) {
      throw new ControllerError("divergent_report", "El intento ya consolidó un reporte diferente.");
    }
    const alreadyAcknowledged =
      envelope.managed.state === "completed" &&
      envelope.managed.ackHash === ledger.ackHash &&
      envelope.managed.humanHash === hashText(envelope.human);
    if (!alreadyAcknowledged) {
      if (envelope.managed.state !== "active") {
        throw new ControllerError(
          "ambiguous_checkpoint",
          "El checkpoint de commit no puede completarse sin intervención.",
        );
      }
      let envelopeHuman = insertReport(envelope.human, report);
      envelopeHuman = updateConsolidationStatus(envelopeHuman, "acknowledged");
      envelopeHuman = updateEnvelopeStatus(envelopeHuman, "completed");
      envelope.managed = {
        ...envelope.managed,
        ackHash: ledger.ackHash,
        consolidatedHash: ledger.consolidatedHash,
        humanHash: hashText(envelopeHuman),
        reportHash,
        revision: envelope.managed.revision + 1,
        state: "completed",
      };
      ledger.envelopeHumanHash = envelope.managed.humanHash;
      await atomicWrite(envelope.path, withManaged(envelopeHuman, envelope.managed));
      await atomicWrite(session.global, withManaged(session.human, session.managed));
    }
    if (attemptIsWriter(session, ledger)) {
      await releaseWriterReservation(options, { preserveForeignOwner: alreadyAcknowledged });
    }
    return commitResult(options, session, ledger, true);
  }
  assertAttemptState(ledger, envelope, ["active"]);

  const outcome =
    ledger.role === "tester"
      ? testerReportPassed(report)
        ? "validated"
        : "failed"
      : ledger.evaluationAxis
        ? evaluationAttemptIsCurrent(session.managed, ledger)
          ? /^- \*\*Veredicto:\*\*\s*aprobado\.?$/m.test(report)
            ? "approved"
            : "changes_required"
          : "obsolete"
        : "completed";
  const section = consolidationSection(options, envelope, {
    hash: reportHash,
    result: outcome,
    state: "completed",
  });
  const consolidatedHash = hashText(section);
  const ackHash = hashText(
    stableJson({ attempt: options.attempt, reportHash, session: options.session }),
  );
  let envelopeHuman = insertReport(envelope.human, report);
  envelopeHuman = updateConsolidationStatus(envelopeHuman, "acknowledged");
  envelopeHuman = updateEnvelopeStatus(envelopeHuman, "completed");
  envelope.managed = {
    ...envelope.managed,
    ackHash,
    consolidatedHash,
    humanHash: hashText(envelopeHuman),
    reportHash,
    revision: envelope.managed.revision + 1,
    state: "completed",
  };
  Object.assign(ledger, {
    ackHash,
    consolidatedHash,
    envelopeHumanHash: envelope.managed.humanHash,
    reportHash,
    evidence: {
      outcome,
      reportHash,
    },
    state: "completed",
  });
  advanceWorkUnitOnCommit(session, ledger, options.attempt, report);
  advanceEvaluationOnCommit(session, ledger, options.attempt, report);
  session.managed.revision += 1;
  const globalHuman = insertConsolidation(session.human, section);
  await atomicWrite(session.global, withManaged(globalHuman, session.managed));
  await atomicWrite(envelope.path, withManaged(envelopeHuman, envelope.managed));
  if (attemptIsWriter(session, ledger)) await releaseWriterReservation(options);
  return commitResult(options, session, ledger);
}

async function commandFail(options, payload) {
  const session = await readGlobal(options);
  if (!session.managed) throw new ControllerError("legacy_requires_init", "La sesión legacy debe adoptarse con init.");
  validateGlobal(session.managed, options.session);
  assertRevision(options.expectedRevision, session.managed.revision);
  const envelope = await readEnvelope(session, options);
  const ledger = ledgerAttempt(session, options);
  if (typeof payload.cause !== "string" || !payload.cause.trim()) {
    throw new ControllerError("invalid_failure_cause", "fail exige una causa no vacía.", 2);
  }
  const cause = payload.cause.trim();
  const ackHash = hashText(
    stableJson({ attempt: options.attempt, cause, session: options.session }),
  );
  const section = failureSection(options, envelope, ackHash);
  const consolidatedHash = hashText(section);
  if (ledger.state === "failed" && envelope.managed.state === "failed") {
    if (ledger.cause !== cause || envelope.managed.cause !== cause) {
      throw new ControllerError(
        "divergent_failure",
        "El intento ya falló con otra causa.",
      );
    }
    if (
      ledger.ackHash !== ackHash ||
      envelope.managed.ackHash !== ackHash ||
      ledger.consolidatedHash !== consolidatedHash ||
      envelope.managed.consolidatedHash !== consolidatedHash ||
      envelope.managed.humanHash !== hashText(envelope.human) ||
      !session.human.includes(section) ||
      !hasEnvelopeStatus(envelope.human, "failed")
    ) {
      throw new ControllerError(
        "ambiguous_checkpoint",
        "El estado confirmado de fail es inconsistente.",
      );
    }
    if (attemptIsWriter(session, ledger)) {
      await releaseWriterReservation(options, { preserveForeignOwner: true });
    }
    return {
      attempt: options.attempt,
      command: "fail",
      revision: session.managed.revision,
      session: options.session,
      state: "failed",
    };
  }
  if (
    ledger.state === "failed" &&
    ["active", "awaiting_input"].includes(envelope.managed.state)
  ) {
    const checkpointState = envelope.managed.state;
    if (ledger.cause !== cause) {
      throw new ControllerError(
        "divergent_failure",
        "El intento ya falló con otra causa.",
      );
    }
    if (
      ledger.ackHash !== ackHash ||
      ledger.cause !== cause ||
      ledger.consolidatedHash !== consolidatedHash ||
      !session.human.includes(section) ||
      !hasEnvelopeStatus(envelope.human, checkpointState)
    ) {
      throw new ControllerError(
        "ambiguous_checkpoint",
        "El checkpoint de fail no puede completarse sin intervención.",
      );
    }
    let envelopeHuman = updateConsolidationStatus(envelope.human, "acknowledged");
    envelopeHuman = updateEnvelopeStatus(envelopeHuman, "failed");
    Object.assign(envelope.managed, {
      ackHash,
      cause,
      consolidatedHash,
      humanHash: hashText(envelopeHuman),
      revision: envelope.managed.revision + 1,
      state: "failed",
    });
    ledger.envelopeHumanHash = envelope.managed.humanHash;
    await atomicWrite(envelope.path, withManaged(envelopeHuman, envelope.managed));
    if (attemptIsWriter(session, ledger)) await releaseWriterReservation(options);
    return {
      attempt: options.attempt,
      command: "fail",
      revision: session.managed.revision,
      session: options.session,
      state: "failed",
    };
  }
  assertAttemptState(ledger, envelope, ["active", "awaiting_input"]);
  let envelopeHuman = updateConsolidationStatus(envelope.human, "acknowledged");
  envelopeHuman = updateEnvelopeStatus(envelopeHuman, "failed");
  Object.assign(envelope.managed, {
    ackHash,
    cause,
    consolidatedHash,
    humanHash: hashText(envelopeHuman),
    revision: envelope.managed.revision + 1,
    state: "failed",
  });
  Object.assign(ledger, {
    ackHash,
    cause,
    consolidatedHash: envelope.managed.consolidatedHash,
    envelopeHumanHash: envelope.managed.humanHash,
    state: "failed",
  });
  advanceUnitOnFail(session, ledger, options.attempt, cause);
  session.managed.revision += 1;
  await atomicWrite(session.global, withManaged(insertConsolidation(session.human, section), session.managed));
  await atomicWrite(envelope.path, withManaged(envelopeHuman, envelope.managed));
  if (attemptIsWriter(session, ledger)) await releaseWriterReservation(options);
  return {
    attempt: options.attempt,
    command: "fail",
    revision: session.managed.revision,
    session: options.session,
    state: "failed",
  };
}

async function classifyAttempts(session) {
  const attempts = [];
  for (const [attempt, ledger] of Object.entries(session.managed.attempts)) {
    const path = join(session.subdirectory, `${attempt}.md`);
    let classification = "ambiguous";
    if (existsSync(path)) {
      try {
        const source = await readUtf8(path);
        const envelope = splitManaged(source, path);
        const acknowledged =
          ["completed", "failed"].includes(ledger.state) &&
          envelope.managed?.state === ledger.state &&
          envelope.managed?.ackHash === ledger.ackHash &&
          envelope.managed?.humanHash === hashText(envelope.human);
        classification = acknowledged ? "safe_to_delete" : "recoverable";
      } catch {
        classification = "ambiguous";
      }
    } else if (["completed", "failed"].includes(ledger.state) && ledger.ackHash) {
      classification = "safe_to_delete";
    } else {
      classification = "recoverable";
    }
    attempts.push({ attempt, classification, state: ledger.state });
  }
  return attempts;
}

function statusAttempts(session) {
  return Object.entries(session.managed.attempts).map(([attempt, ledger]) => ({
    attempt,
    classification:
      ["completed", "failed"].includes(ledger.state) && ledger.ackHash
        ? "safe_to_delete"
        : "recoverable",
    state: ledger.state,
  }));
}

async function classifyResidues(session) {
  const residues = [];
  if (existsSync(session.sessions)) {
    for (const entry of await readdir(session.sessions, { withFileTypes: true })) {
      if (
        entry.name === `${session.managed.sessionSlug}.md` ||
        entry.name === session.managed.sessionSlug ||
        entry.name === "gitignore.asset" ||
        entry.name === ".gitignore"
      ) {
        continue;
      }
      if (entry.name === `${session.managed.sessionSlug}.md.lock`) {
        const lock = await inspectMutationLock(join(session.sessions, entry.name));
        if (lock?.owner?.token === activeMutationLockToken) continue;
        residues.push({
          classification: lock?.classification ?? "ambiguous",
          name: entry.name,
          state: lock?.state ?? "invalid",
        });
        continue;
      }
      if (!entry.name.startsWith(`${session.managed.sessionSlug}.`)) continue;
      let classification = "ambiguous";
      if (entry.name.startsWith(`${session.managed.sessionSlug}.md.tmp-`)) {
        classification = "recoverable";
      }
      residues.push({ classification, name: entry.name });
    }
  }
  if (existsSync(session.subdirectory)) {
    const envelopes = new Set(
      Object.keys(session.managed.attempts).map((attempt) => `${attempt}.md`),
    );
    for (const entry of await readdir(session.subdirectory, { withFileTypes: true })) {
      if (entry.isFile() && envelopes.has(entry.name)) continue;
      const temporaryAttempt = entry.name.match(/^(.+)\.md\.tmp-/)?.[1];
      const classification =
        entry.isFile() && temporaryAttempt && ATTEMPT_PATTERN.test(temporaryAttempt)
          ? "recoverable"
          : "ambiguous";
      residues.push({
        classification,
        name: `${session.managed.sessionSlug}/${entry.name}`,
      });
    }
  }
  return residues.sort((left, right) => left.name.localeCompare(right.name));
}

async function recoveryResult(options, command = "recover") {
  const session = await readGlobal(options);
  if (!session.managed) {
    return {
      attempts: [],
      command,
      legacy: true,
      residues: [],
      revision: 0,
      session: options.session,
    };
  }
  validateGlobal(session.managed, options.session);
  return {
    attempts: await classifyAttempts(session),
    command,
    residues: await classifyResidues(session),
    revision: session.managed.revision,
    session: options.session,
  };
}

async function commandCleanup(options) {
  const session = await readGlobal(options);
  if (!session.managed) throw new ControllerError("legacy_requires_init", "La sesión legacy debe adoptarse con init.");
  validateGlobal(session.managed, options.session);
  assertRevision(options.expectedRevision, session.managed.revision);
  const attempts = await classifyAttempts(session);
  const deleted = [];
  for (const attempt of attempts) {
    if (attempt.classification !== "safe_to_delete") continue;
    await rm(join(session.subdirectory, `${attempt.attempt}.md`), { force: true });
    session.managed.attempts[attempt.attempt].cleaned = true;
    deleted.push(attempt.attempt);
  }
  await rmdir(session.subdirectory).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
  });
  session.managed.revision += 1;
  await atomicWrite(session.global, withManaged(session.human, session.managed));
  return {
    command: "cleanup",
    deleted,
    revision: session.managed.revision,
    session: options.session,
  };
}

async function commandClose(options) {
  const session = await readGlobal(options);
  if (!session.managed) throw new ControllerError("legacy_requires_init", "La sesión legacy debe adoptarse con init.");
  validateGlobal(session.managed, options.session);
  assertRevision(options.expectedRevision, session.managed.revision);
  if (session.managed.workUnits && !workUnitStatus(session.managed).fanInReady) {
    throw new ControllerError(
      "session_fan_in_pending",
      "La DevSession no puede cerrar antes del fan-in de unidades validadas.",
    );
  }
  if (
    session.managed.workUnits &&
    !finalEvaluationStatus(session.managed).finalEvaluation.approved
  ) {
    throw new ControllerError(
      "session_evaluation_pending",
      "La DevSession no puede cerrar sin todos los ejes aprobados.",
    );
  }
  const attempts = await classifyAttempts(session);
  if (attempts.some((attempt) => !["completed", "failed"].includes(attempt.state))) {
    throw new ControllerError(
      "session_has_pending_attempts",
      "La DevSession contiene intentos abiertos o recuperables.",
    );
  }
  if (attempts.some((attempt) => !session.managed.attempts[attempt.attempt].cleaned)) {
    throw new ControllerError(
      "session_has_pending_cleanup",
      "La DevSession contiene sobres sin limpieza confirmada.",
    );
  }
  const residues = await classifyResidues(session);
  if (residues.length) {
    throw new ControllerError(
      "session_has_residues",
      "La DevSession conserva residuos recuperables o ambiguos.",
    );
  }
  await rm(session.global);
  return { command: "close", deleted: true, session: options.session, state: "completed" };
}

async function commandStatus(options) {
  const session = await readGlobal(options);
  if (!session.managed) {
    return {
      attempts: [],
      classification: "recoverable",
      command: "status",
      legacy: true,
      revision: 0,
      session: options.session,
      state: "active",
    };
  }
  validateGlobal(session.managed, options.session);
  const attempts = statusAttempts(session);
  const residues = await classifyResidues(session);
  const classifications = [
    ...attempts.map((attempt) => attempt.classification),
    ...residues.map((residue) => residue.classification),
  ];
  const classification = classifications.includes("ambiguous")
    ? "ambiguous"
    : classifications.includes("recoverable")
      ? "recoverable"
      : "safe_to_delete";
  return {
    attempts,
    classification,
    command: "status",
    legacy: false,
    residues,
    revision: session.managed.revision,
    session: options.session,
    state: session.managed.closed ? "completed" : "active",
    ...workUnitStatus(session.managed),
    ...finalEvaluationStatus(session.managed),
  };
}

let currentOptions;

async function main() {
  currentOptions = parseArguments(process.argv.slice(2));
  const payload = await readPayload();
  if (currentOptions.command === "status") return commandStatus(currentOptions);
  if (currentOptions.command === "recover") return recoveryResult(currentOptions);
  return withMutationLock(currentOptions, async () => {
    if (currentOptions.command === "init") return commandInit(currentOptions, payload);
    if (currentOptions.command === "open") return commandOpen(currentOptions, payload);
    if (currentOptions.command === "await-input") {
      return commandAwaitInput(currentOptions, payload);
    }
    if (currentOptions.command === "resume") return commandResume(currentOptions, payload);
    if (currentOptions.command === "commit") return commandCommit(currentOptions, payload);
    if (currentOptions.command === "fail") return commandFail(currentOptions, payload);
    if (currentOptions.command === "cleanup") return commandCleanup(currentOptions);
    if (currentOptions.command === "close") return commandClose(currentOptions);
    throw new ControllerError("not_implemented", `${currentOptions.command} aún no está implementado.`);
  });
}

try {
  stdout.write(`${stableJson(await main())}\n`);
} catch (error) {
  const controlled = error instanceof ControllerError;
  stderr.write(
    `${stableJson({ error: controlled ? error.id : "io_error", message: error.message })}\n`,
  );
  process.exitCode = controlled ? error.exitCode : 1;
}
