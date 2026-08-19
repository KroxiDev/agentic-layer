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
  node .agents/scripts/kernel-cli.mjs apply <tipo> --session <id> --command-id <id> \\
    --expected-revision <n> [--payload <archivo.json|->]

El CLI aporta schemaVersion y la capacidad del actor; --payload admite "-"
para leer el payload por stdin y se omite cuando el payload es vacío.`;
const APPLY_FLAGS = new Map([
  ["--command-id", "commandId"],
  ["--expected-revision", "expectedRevision"],
  ["--payload", "payload"],
  ["--session", "sessionId"],
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
