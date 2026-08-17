// agentic-protocol-core
import { createHash, randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 2;

export class KernelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.details = details;
  }
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function digestObject(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function acceptanceContractHash(contract) {
  const { hash: _ignored, ...hashable } = contract;
  return digestObject(hashable);
}

export function withAcceptanceContractHash(contract) {
  return { ...contract, hash: acceptanceContractHash(contract) };
}

export function commandFingerprint(command) {
  return digestObject({
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
    payload: command.payload ?? {},
    schemaVersion: command.schemaVersion,
    sessionId: command.sessionId,
    type: command.type,
  });
}

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export function eventId(commandId) {
  return `${commandId}:${randomUUID()}`;
}

export function assertRecord(value, label, code = "invalid_command") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KernelError(code, `${label} debe ser un objeto.`);
  }
}

export function assertNonEmptyString(value, label, code = "invalid_command") {
  if (typeof value !== "string" || !value.trim()) {
    throw new KernelError(code, `${label} debe ser un string no vacío.`);
  }
}

export function assertOpaqueIdentifier(value, label, code = "invalid_command") {
  assertNonEmptyString(value, label, code);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new KernelError(code, `${label} contiene caracteres inseguros o supera 128 caracteres.`);
  }
}

export function validateSessionId(sessionId) {
  assertNonEmptyString(sessionId, "sessionId");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(sessionId)) {
    throw new KernelError(
      "invalid_session_id",
      "sessionId debe usar minúsculas, números y guiones, sin escapar su directorio.",
    );
  }
}

export function validateBaseCommand(command) {
  assertRecord(command, "command");
  if (command.schemaVersion !== SCHEMA_VERSION) {
    throw new KernelError("unsupported_schema", "El comando debe usar schemaVersion 2.");
  }
  assertOpaqueIdentifier(command.commandId, "commandId");
  validateSessionId(command.sessionId);
  assertNonEmptyString(command.type, "type");
  if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw new KernelError("invalid_command", "expectedRevision debe ser un entero no negativo.");
  }
  if (command.payload !== undefined) assertRecord(command.payload, "payload");
}

export function redactEvent(value) {
  if (Array.isArray(value)) return value.map(redactEvent);
  if (!value || typeof value !== "object") return value;
  const redacted = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/capability|secret|token|prompt|content/i.test(key)) continue;
    redacted[key] = redactEvent(nested);
  }
  return redacted;
}
