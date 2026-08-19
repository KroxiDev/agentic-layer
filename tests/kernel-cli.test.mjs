import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { COMMAND_PAYLOAD_KEYS } from "../.agents/kernel/orchestration-kernel.mjs";
import { digestObject, withAcceptanceContractHash } from "../.agents/kernel/protocol.mjs";
import { SIN_HERRAMIENTAS, createRepository, runInitializer } from "./agentic-test-helpers.mjs";

const SESSION = "cli-session";

function runCli(repository, cliArguments, { input } = {}) {
  return spawnSync(
    process.execPath,
    [join(repository, ".agents", "scripts", "kernel-cli.mjs"), ...cliArguments],
    { cwd: repository, encoding: "utf8", input },
  );
}

function parseStdout(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function parseStderr(result) {
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stderr);
}

async function adoptedRepository(name) {
  const repository = await createRepository({
    "package.json": JSON.stringify({
      name,
      description: "Conduce el kernel de orquestación desde el CLI delgado.",
    }),
  });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  return repository;
}

function acceptanceContract() {
  return withAcceptanceContractHash({
    schemaVersion: 3,
    contractId: "AC-CLI-01",
    version: 1,
    userIntent: "Conducir una unidad completa desde el CLI.",
    nonGoals: ["No ampliar el kernel."],
    riskClass: "medium",
    criteria: [
      {
        id: "AC-CLI-01-C01",
        statement: "La sesión se conduce por procesos separados.",
        oracle: "Reporte estructurado.",
      },
    ],
    transversalPolicies: [{ id: "POL-01", version: "1" }],
    threatModel: { commitPoints: [], enumeratedFaults: [], excludedFaults: [] },
    approval: { kind: "explicit-user-or-policy", reference: "fixture" },
  });
}

function roleReport(contract, attemptId, role) {
  return {
    schemaVersion: 3,
    sessionId: SESSION,
    attemptId,
    acceptanceContractHash: contract.hash,
    role,
    completion: "completed",
    decision: "pass",
    findings: [],
    evidence: [
      { kind: "command", commandDigest: digestObject(attemptId), exitCode: 0, durationMs: 1 },
    ],
    humanSummary: "Completado.",
  };
}

function dispatchPayload(attemptId, role, permission, extra = {}) {
  return {
    attemptId,
    baseRevision: "git:cli-base",
    contextManifest: [],
    findings: [],
    objective: `Ejecutar ${role}.`,
    permission,
    phase: `${role}-phase`,
    role,
    rules: "Aplicar el contrato.",
    tasks: "Completar el intento.",
    threadId: `thread-${attemptId}`,
    ...extra,
  };
}

test("help imprime las claves exactas de cada payload derivadas del kernel", async () => {
  const repository = await adoptedRepository("kernel-cli-help");

  const listing = parseStdout(runCli(repository, ["help"]));
  assert.deepEqual(listing.commands, Object.keys(COMMAND_PAYLOAD_KEYS));

  for (const [type, keys] of Object.entries(COMMAND_PAYLOAD_KEYS)) {
    const help = parseStdout(runCli(repository, ["help", type]));
    assert.deepEqual(help, { type, payloadKeys: [...keys] });
  }
  assert.equal(
    parseStdout(runCli(repository, ["help", "dispatch-attempt"])).payloadKeys.length,
    16,
  );

  const unknown = parseStderr(runCli(repository, ["help", "no-existe"]));
  assert.equal(unknown.code, "unknown_command");
});

test("una sesión completa se conduce por procesos separados sin exponer capacidades", async () => {
  const repository = await adoptedRepository("kernel-cli-session");
  const contract = acceptanceContract();
  const outputs = [];

  function applyStep(type, commandId, expectedRevision, payload, options = {}) {
    const cliArguments = [
      "apply",
      type,
      "--session",
      SESSION,
      "--command-id",
      commandId,
      "--expected-revision",
      String(expectedRevision),
    ];
    let input;
    if (payload !== undefined) {
      if (options.stdin) {
        cliArguments.push("--payload", "-");
        input = JSON.stringify(payload);
      } else {
        cliArguments.push("--payload", options.payloadPath);
      }
    }
    const result = runCli(repository, cliArguments, { input });
    outputs.push(result.stdout);
    return result;
  }

  const startPayload = { mode: "light", lightStrategy: "compact", workflow: "feature" };
  const startPath = join(repository, "payload-start.json");
  await writeFile(startPath, JSON.stringify(startPayload), "utf8");

  const started = parseStdout(
    applyStep("start-session", "cli-start", 0, startPayload, { payloadPath: startPath }),
  );
  assert.equal(started.revision, 1);
  assert.equal(started.state, "planning");

  // Idempotencia: el retry exacto devuelve el resultado original.
  const repeated = parseStdout(
    applyStep("start-session", "cli-start", 0, startPayload, { payloadPath: startPath }),
  );
  assert.deepEqual(repeated, started);

  // El mismo commandId con otro payload produce idempotency_conflict.
  const conflictPath = join(repository, "payload-conflict.json");
  await writeFile(
    conflictPath,
    JSON.stringify({ ...startPayload, workflow: "refactor" }),
    "utf8",
  );
  const conflict = parseStderr(
    applyStep("start-session", "cli-start", 0, {}, { payloadPath: conflictPath }),
  );
  assert.equal(conflict.code, "idempotency_conflict");

  const planned = parseStdout(
    applyStep(
      "accept-plan",
      "cli-plan",
      1,
      {
        acceptanceContract: contract,
        documentationRequired: false,
        documentationReason: "No cambia documentación.",
        workUnits: [
          {
            workUnitId: "unit-1",
            criterionIds: ["AC-CLI-01-C01"],
            dependsOn: [],
            ownedPaths: ["src/unit.mjs"],
            permission: "writer",
            validationStrategy: "independent-rerun",
          },
        ],
      },
      { stdin: true },
    ),
  );
  assert.equal(planned.revision, 2);

  // Una revisión obsoleta produce stale_revision sin mutar el estado.
  const before = parseStdout(runCli(repository, ["inspect", SESSION]));
  const stale = parseStderr(
    applyStep(
      "dispatch-attempt",
      "cli-stale",
      0,
      dispatchPayload("attempt-impl", "implementador", "writer", { workUnitId: "unit-1" }),
      { stdin: true },
    ),
  );
  assert.equal(stale.code, "stale_revision");
  assert.deepEqual(parseStdout(runCli(repository, ["inspect", SESSION])), before);

  const dispatched = parseStdout(
    applyStep(
      "dispatch-attempt",
      "cli-impl",
      2,
      dispatchPayload("attempt-impl", "implementador", "writer", { workUnitId: "unit-1" }),
      { stdin: true },
    ),
  );
  assert.equal(dispatched.envelope.role, "implementador");
  const accepted = parseStdout(
    applyStep(
      "accept-role-report",
      "cli-impl-report",
      3,
      { attemptId: "attempt-impl", report: roleReport(contract, "attempt-impl", "implementador") },
      { stdin: true },
    ),
  );
  assert.equal(accepted.state, "evaluating");

  parseStdout(
    applyStep(
      "dispatch-attempt",
      "cli-eval",
      4,
      dispatchPayload("attempt-eval", "evaluador", "read-only", {
        evaluationAxis: "combined",
        phase: "evaluation",
      }),
      { stdin: true },
    ),
  );
  const evaluated = parseStdout(
    applyStep(
      "accept-role-report",
      "cli-eval-report",
      5,
      { attemptId: "attempt-eval", report: roleReport(contract, "attempt-eval", "evaluador") },
      { stdin: true },
    ),
  );
  assert.equal(evaluated.state, "completed");

  const closed = parseStdout(applyStep("close-session", "cli-close", 6, undefined));
  assert.equal(closed.decision, "closed");
  assert.equal(closed.revision, 7);

  // La capacidad no aparece en stdout, en el snapshot ni en el event log; el
  // host no persiste ningún archivo de recuperación propio.
  const stateDirectory = join(repository, ".agents", "sessions", "state");
  const snapshot = await readFile(join(stateDirectory, SESSION, "snapshot.json"), "utf8");
  const events = await readFile(join(stateDirectory, "events.jsonl"), "utf8");
  for (const source of [...outputs, snapshot, events]) {
    assert.doesNotMatch(source, /actorCapability/);
  }
  assert.deepEqual(await readdir(join(stateDirectory, SESSION)), ["snapshot.json"]);
  assert.equal(existsSync(join(repository, ".agents", "sessions", SESSION)), false);

  // La recuperación usa el comando persistido por el kernel, sin capacidad.
  const inspected = parseStdout(runCli(repository, ["inspect", SESSION]));
  assert.deepEqual(inspected.recovery.bootstrapCommand, {
    commandId: "cli-start",
    expectedRevision: 0,
    payload: startPayload,
    schemaVersion: 3,
    sessionId: SESSION,
    type: "start-session",
  });
});
