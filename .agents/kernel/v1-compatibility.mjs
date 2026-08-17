// agentic-v1-compatibility-adapter:v1
import { digestObject } from "./protocol-v2.mjs";

const BLOCK = /<!-- agentic-session:v1:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- agentic-session:v1:end -->/;
const AMBIGUOUS_NARRATIVE = /(?:Fallos|Veredicto|Resultado)\s*:\s*(?:Ninguno reproducible|Ninguno|No aplica)/i;
const WORKFLOWS = new Set(["architecture", "bugfix", "feature", "refactor"]);

function managedBlock(source) {
  const match = source.match(BLOCK);
  const startCount = source.split("<!-- agentic-session:v1:start -->").length - 1;
  const endCount = source.split("<!-- agentic-session:v1:end -->").length - 1;
  if (!match || startCount !== 1 || endCount !== 1) {
    return { integrityIssue: "managed_block_missing_or_duplicated", integrityValid: false };
  }
  try {
    const managed = JSON.parse(match[1]);
    if (!managed || typeof managed !== "object" || Array.isArray(managed)) {
      return { integrityIssue: "managed_block_not_an_object", integrityValid: false };
    }
    return { integrityIssue: undefined, integrityValid: true, managed };
  } catch {
    return { integrityIssue: "managed_block_invalid_json", integrityValid: false };
  }
}

function hasActiveAttempt(managed) {
  return Object.values(managed?.attempts ?? {}).some(
    (attempt) =>
      ["active", "awaiting_input", "pending"].includes(attempt?.state) ||
      (attempt?.state === "completed" && attempt.reportHash && !attempt.ackHash),
  );
}

function stableCriterionMappings(managed) {
  const criteria = new Set();
  for (const unit of Object.values(managed?.workUnits ?? {})) {
    for (const criterion of unit?.acceptanceCriteria ?? []) {
      if (typeof criterion === "string" && criterion.trim()) criteria.add(criterion.trim());
    }
  }
  return [...criteria]
    .sort()
    .map((source) => ({
      id: `LEGACY-${digestObject(source).slice("sha256:".length, "sha256:".length + 12).toUpperCase()}`,
      source,
    }));
}

export class LegacyV1Adapter {
  constructor({ stateStore }) {
    this.stateStore = stateStore;
  }

  async inspect(sessionId) {
    const source = await this.stateStore.loadLegacy?.(sessionId);
    if (source === undefined) return undefined;
    const block = managedBlock(source);
    const managed = block.managed;
    const legacyAmbiguous = !block.integrityValid || AMBIGUOUS_NARRATIVE.test(source);
    return {
      schemaVersion: 1,
      sessionId,
      revision: Number.isInteger(managed?.revision) ? managed.revision : 0,
      state: managed?.closed ? "completed" : "legacy",
      lifecycle: managed?.closed ? "completed" : "legacy",
      workflow: WORKFLOWS.has(managed?.workflow) ? managed.workflow : "unknown",
      mode: ["full", "light"].includes(managed?.mode) ? managed.mode : "unknown",
      integrityIssue: block.integrityIssue,
      integrityValid: block.integrityValid,
      criterionMappings: stableCriterionMappings(managed),
      legacyAmbiguous,
      activeCheckpointRequired: hasActiveAttempt(managed),
      sourceHash: digestObject(source),
      unknown: {
        acceptanceContract: true,
        actor: true,
        threatModel: true,
        timestamps: true,
      },
    };
  }

  async planMigration(sessionId) {
    const view = await this.inspect(sessionId);
    if (!view) return undefined;
    const blockers = [];
    if (!view.integrityValid) blockers.push(view.integrityIssue);
    if (view.activeCheckpointRequired) blockers.push("active_checkpoint_required");
    return {
      changes: [
        "Crear snapshot v2 aditivo.",
        "Registrar migratedFrom y hash de origen.",
        "Conservar como unknown los hechos históricos no demostrables.",
      ],
      dryRun: true,
      blockers,
      eligible: blockers.length === 0,
      legacyAmbiguous: view.legacyAmbiguous,
      sessionId,
      sourceHash: view.sourceHash,
      targetSchemaVersion: 2,
    };
  }
}
