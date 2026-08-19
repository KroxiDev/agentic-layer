#!/usr/bin/env node
// agentic-kernel-cli
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createOrchestrationComposition } from "../kernel/composition.mjs";
import { COMMAND_PAYLOAD_KEYS } from "../kernel/orchestration-kernel.mjs";
import { KernelError, SCHEMA_VERSION } from "../kernel/protocol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = `Uso:
  node .agents/scripts/kernel-cli.mjs help [tipo]
  node .agents/scripts/kernel-cli.mjs inspect <sessionId>
  node .agents/scripts/kernel-cli.mjs brief <sessionId> <attemptId>
  node .agents/scripts/kernel-cli.mjs apply <tipo> --session <id> --command-id <id> \\
    --expected-revision <n> [--payload <archivo.json|->]
  node .agents/scripts/kernel-cli.mjs retry <sessionId> <attemptIdFallido> \\
    --attempt-id <nuevo> --command-id <id> --expected-revision <n> [--retry-cause <causa>]

El CLI aporta schemaVersion y la capacidad del actor; --payload admite "-"
para leer el payload por stdin y se omite cuando el payload es vacío.`;
const APPLY_FLAGS = new Map([
  ["--command-id", "commandId"],
  ["--expected-revision", "expectedRevision"],
  ["--payload", "payload"],
  ["--session", "sessionId"],
]);
const RETRY_FLAGS = new Map([
  ["--attempt-id", "attemptId"],
  ["--command-id", "commandId"],
  ["--expected-revision", "expectedRevision"],
  ["--retry-cause", "retryCause"],
]);

function usageError(message) {
  throw Object.assign(new Error(message), { usage: true });
}

function printJson(value) {
  process.stdout.write(
    `${JSON.stringify(value, (key, nested) => (key === "actorCapability" ? undefined : nested), 2)}\n`,
  );
}

function parseApplyArguments(argumentList) {
  const options = {};
  for (let index = 0; index < argumentList.length; index += 2) {
    const name = APPLY_FLAGS.get(argumentList[index]);
    if (!name) usageError(`Argumento no reconocido: ${argumentList[index]}.`);
    if (index + 1 >= argumentList.length) usageError(`Falta el valor de ${argumentList[index]}.`);
    options[name] = argumentList[index + 1];
  }
  for (const [flag, name] of APPLY_FLAGS) {
    if (name !== "payload" && !(name in options)) usageError(`Falta ${flag}.`);
  }
  return options;
}

function parseRetryArguments(argumentList) {
  const options = {};
  for (let index = 0; index < argumentList.length; index += 2) {
    const name = RETRY_FLAGS.get(argumentList[index]);
    if (!name) usageError(`Argumento no reconocido: ${argumentList[index]}.`);
    if (index + 1 >= argumentList.length) usageError(`Falta el valor de ${argumentList[index]}.`);
    options[name] = argumentList[index + 1];
  }
  for (const [flag, name] of RETRY_FLAGS) {
    if (name !== "retryCause" && !(name in options)) usageError(`Falta ${flag}.`);
  }
  return options;
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function readPayload(source) {
  if (source === undefined) return {};
  const text = source === "-" ? await readStdin() : await readFile(source, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    usageError(`El payload no es JSON válido: ${error.message}`);
  }
}

function assertKnownType(type) {
  if (!Object.hasOwn(COMMAND_PAYLOAD_KEYS, type ?? "")) {
    throw new KernelError("unknown_command", `Comando desconocido: ${type ?? "(ninguno)"}.`);
  }
}

async function recoverAuthority(composition, sessionId) {
  const bootstrapCommand = (await composition.inspect(sessionId))?.recovery?.bootstrapCommand;
  if (!bootstrapCommand) {
    throw new KernelError(
      "recovery_unavailable",
      `El snapshot de ${sessionId} no expone recovery.bootstrapCommand.`,
    );
  }
  const recovered = await composition.apply({
    ...bootstrapCommand,
    actorCapability: composition.bootstrapCapability,
  });
  return recovered.actorCapability;
}

// El brief es el prompt completo de un despacho ya materializado: contrato del
// rol verbatim, sobre exacto y contrato del reporte derivado del schema vigente.
function renderBrief(envelope, roleContract, schema) {
  const finding = schema.properties.findings.items.properties;
  return `# Despacho ${envelope.attemptId} — rol ${envelope.role}

Sesión \`${envelope.sessionId}\` · fase \`${envelope.phase}\` · permiso
\`${envelope.permission}\` · generación ${envelope.generation}.

## Contrato del rol

${roleContract.trim()}

## WorkEnvelope

\`\`\`json
${JSON.stringify(envelope, null, 2)}
\`\`\`

## Contrato del RoleReport

- Claves obligatorias: ${schema.required.join(", ")}.
- \`completion\`: ${schema.properties.completion.enum.join(" | ")}.
- \`decision\`: ${schema.properties.decision.enum.join(" | ")}.
- \`findings[].classification\`: ${finding.classification.enum.join(" | ")}.
- \`findings[].severity\`: ${finding.severity.enum.join(" | ")}.
- Todo finding no informativo exige \`reproduction\` (\`commandDigest\`,
  \`expected\`, \`observed\`); \`decision: "fail"\` exige al menos un finding
  accionable.
- \`evidence[]\`: \`{ kind: "command", commandDigest, exitCode, durationMs }\`;
  \`decision: "pass"\` exige \`exitCode\` 0 en toda la evidencia.
- Identidad exacta: \`schemaVersion\` ${schema.properties.schemaVersion.const},
  \`sessionId\` \`${envelope.sessionId}\`, \`attemptId\` \`${envelope.attemptId}\`,
  \`acceptanceContractHash\` \`${envelope.acceptanceContractHash}\`, \`role\`
  \`${envelope.role}\`.

Devolver únicamente el RoleReport JSON.
`;
}

async function readBrief(sessionId, attemptId) {
  const composition = createOrchestrationComposition({ root: ROOT });
  const envelope = (await composition.inspect(sessionId))?.attempts?.[attemptId]?.envelope;
  if (!envelope) {
    throw new KernelError(
      "attempt_not_found",
      `La sesión ${sessionId} no expone el intento ${attemptId}.`,
    );
  }
  const [roleContract, schemaSource] = await Promise.all([
    readFile(resolve(ROOT, ".agents", "roles", `${envelope.role}.md`), "utf8"),
    readFile(resolve(ROOT, ".agents", "schemas", "role-report.schema.json"), "utf8"),
  ]);
  return renderBrief(envelope, roleContract, JSON.parse(schemaSource));
}

// El retry re-despacha desde el sobre persistido del intento fallido: el
// orquestador no reconstruye a mano un payload que el kernel ya validó.
async function retryAttempt(sessionId, failedAttemptId, options) {
  const composition = createOrchestrationComposition({ root: ROOT });
  const failed = (await composition.inspect(sessionId))?.attempts?.[failedAttemptId];
  if (!failed) {
    throw new KernelError(
      "attempt_not_found",
      `La sesión ${sessionId} no expone el intento ${failedAttemptId}.`,
    );
  }
  if (failed.state !== "failed") {
    throw new KernelError("attempt_not_retryable", "Solo un intento en estado failed admite retry.");
  }
  const envelope = failed.envelope;
  const payload = {
    attemptId: options.attemptId,
    baseRevision: envelope.baseRevision,
    contextManifest: envelope.contextManifest,
    findings: envelope.findings,
    objective: envelope.objective,
    permission: envelope.permission,
    phase: envelope.phase,
    retryCause: options.retryCause ?? failed.failure.retryCause,
    role: envelope.role,
    rules: envelope.rules,
    tasks: envelope.tasks,
    threadId: envelope.threadId,
    ...(envelope.workUnitId ? { workUnitId: envelope.workUnitId } : {}),
    ...(envelope.laneId ? { laneId: envelope.laneId } : {}),
    ...(envelope.evaluationAxis ? { evaluationAxis: envelope.evaluationAxis } : {}),
  };
  return composition.apply({
    actorCapability: await recoverAuthority(composition, sessionId),
    commandId: options.commandId,
    expectedRevision: Number(options.expectedRevision),
    payload,
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    type: "dispatch-attempt",
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "help") {
    if (rest[0] === undefined) {
      printJson({ commands: Object.keys(COMMAND_PAYLOAD_KEYS) });
      return;
    }
    assertKnownType(rest[0]);
    printJson({ type: rest[0], payloadKeys: [...COMMAND_PAYLOAD_KEYS[rest[0]]] });
    return;
  }
  if (command === "inspect") {
    if (rest.length !== 1) usageError("inspect exige exactamente <sessionId>.");
    const composition = createOrchestrationComposition({ root: ROOT });
    printJson(await composition.inspect(rest[0]));
    return;
  }
  if (command === "brief") {
    if (rest.length !== 2) usageError("brief exige exactamente <sessionId> <attemptId>.");
    process.stdout.write(await readBrief(rest[0], rest[1]));
    return;
  }
  if (command === "retry") {
    const [sessionId, failedAttemptId, ...flagArguments] = rest;
    if (failedAttemptId === undefined) {
      usageError("retry exige <sessionId> <attemptIdFallido> y sus flags.");
    }
    printJson(await retryAttempt(sessionId, failedAttemptId, parseRetryArguments(flagArguments)));
    return;
  }
  if (command === "apply") {
    const [type, ...flagArguments] = rest;
    assertKnownType(type);
    const options = parseApplyArguments(flagArguments);
    const payload = await readPayload(options.payload);
    const composition = createOrchestrationComposition({ root: ROOT });
    const actorCapability =
      type === "start-session"
        ? composition.bootstrapCapability
        : await recoverAuthority(composition, options.sessionId);
    printJson(
      await composition.apply({
        actorCapability,
        commandId: options.commandId,
        expectedRevision: Number(options.expectedRevision),
        payload,
        schemaVersion: SCHEMA_VERSION,
        sessionId: options.sessionId,
        type,
      }),
    );
    return;
  }
  usageError(`Subcomando desconocido: ${command ?? "(ninguno)"}.`);
}

main().catch((error) => {
  if (error?.usage) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(
    `${JSON.stringify({
      code: typeof error?.code === "string" ? error.code : "unexpected_error",
      details: error?.details ?? {},
      message: error?.message ?? String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
