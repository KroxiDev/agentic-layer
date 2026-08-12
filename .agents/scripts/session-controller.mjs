#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, open as openFile, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
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
}

function renderGlobalTemplate(template, { mode, objective, session, workflow }) {
  return template
    .replace("<slug>", session)
    .replace("- Objetivo:", `- Objetivo: ${objective ?? "Pendiente"}`)
    .replace("- Workflow: feature | bugfix | refactor | architecture", `- Workflow: ${workflow}`)
    .replace("- Modo: full | light", `- Modo: ${mode ?? "full"}`)
    .replace("- Fase actual:", "- Fase actual: Pendiente");
}

async function commandInit(options, payload) {
  const session = await readGlobal(options, false);
  const legacy = session.exists && !session.managed;
  if (session.managed) {
    validateGlobal(session.managed, options.session);
    assertRevision(options.expectedRevision, session.managed.revision);
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
  const output = source.match(/^## Salida\n([\s\S]*?)(?=^## |\z)/m)?.[1];
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

  const identity = parseAttempt(options.attempt);
  if (payload.phaseId !== identity.phaseId || payload.role !== identity.role) {
    throw new ControllerError("attempt_identity_conflict", "El payload contradice la identidad del intento.");
  }
  const workflowPath = join(options.root, ".agents", "workflows", `${session.managed.workflow}.md`);
  const phases = parsePhases(await readUtf8(workflowPath));
  if (phases.get(identity.phaseId) !== identity.role) {
    throw new ControllerError("attempt_identity_conflict", "La fase y el rol contradicen el workflow.");
  }
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
  const prior = Object.values(session.managed.attempts).filter(
    (attempt) => attempt.phaseId === identity.phaseId,
  );
  const expectedAttempt = Math.max(0, ...prior.map((attempt) => attempt.attempt)) + 1;
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
  const rolePath = join(options.root, ".agents", "roles", `${identity.role}.md`);
  const contract = parseRoleContract(await readUtf8(rolePath));
  const templatePath = join(options.root, ".agents", "templates", "subdev-session.md");
  const human = renderSubdevTemplate(await readUtf8(templatePath), {
    ...identity,
    ...payload,
    ...reworkTrace,
    contract,
    identity: options.attempt,
    session: options.session,
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
    sessionSlug: options.session,
    state: "active",
    version: 1,
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
  session.managed.attempts[options.attempt] = {
    attempt: identity.attempt,
    ...reworkTrace,
    openPayloadHash,
    phaseId: identity.phaseId,
    role: identity.role,
    state: "active",
  };
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

function consolidationSection(options, envelope, report) {
  return `### ${roleTitle(envelope.managed.role)} ${envelope.managed.phaseId} — intento ${envelope.managed.attempt}\n\n${report}\n`;
}

function insertConsolidation(human, section) {
  const heading = "## Control de consolidación";
  const at = human.indexOf(heading);
  if (at >= 0) return `${human.slice(0, at).replace(/\n+$/, "")}\n\n${section}\n${human.slice(at)}`;
  return `${human.replace(/\n+$/, "")}\n\n${section}`;
}

function failureSection(options, envelope, cause) {
  return `### ${roleTitle(envelope.managed.role)} ${envelope.managed.phaseId} — intento ${envelope.managed.attempt}, fallo sin reporte\n\n- Causa: ${cause}\n`;
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
    return commitResult(options, session, ledger, true);
  }
  assertAttemptState(ledger, envelope, ["active"]);

  const section = consolidationSection(options, envelope, report);
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
    state: "completed",
  });
  session.managed.revision += 1;
  const globalHuman = insertConsolidation(session.human, section);
  await atomicWrite(session.global, withManaged(globalHuman, session.managed));
  await atomicWrite(envelope.path, withManaged(envelopeHuman, envelope.managed));
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
  const section = failureSection(options, envelope, cause);
  const consolidatedHash = hashText(section);
  const ackHash = hashText(
    stableJson({ attempt: options.attempt, cause, session: options.session }),
  );
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
  session.managed.revision += 1;
  await atomicWrite(session.global, withManaged(insertConsolidation(session.human, section), session.managed));
  await atomicWrite(envelope.path, withManaged(envelopeHuman, envelope.managed));
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
  const attempts = await classifyAttempts(session);
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
