import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { KernelError, digestObject } from "../kernel/protocol-v2.mjs";

const ROLES = ["documentador", "evaluador", "explorador", "implementador", "planificador", "tester"];
const WORKFLOWS = ["architecture", "bugfix", "feature", "refactor"];
const SCHEMAS = [
  "acceptance-contract.v2.schema.json",
  "role-report.v2.schema.json",
  "session-event.v2.schema.json",
  "validation-evidence.v2.schema.json",
];

async function source(root, relativePath) {
  try {
    return await readFile(join(root, ...relativePath.split("/")), "utf8");
  } catch (error) {
    throw new KernelError("conformance_missing_artifact", `Falta ${relativePath}: ${error.message}`);
  }
}

function exactVersion(manifest, artifact) {
  if (manifest.artifacts?.[artifact] !== 2) {
    throw new KernelError(
      "conformance_version_mismatch",
      `${artifact} declara versión ${manifest.artifacts?.[artifact] ?? "ausente"}; se esperaba 2.`,
    );
  }
}

function marker(content, expected, relativePath) {
  if (!content.includes(expected)) {
    throw new KernelError(
      "conformance_version_mismatch",
      `${relativePath} no declara ${expected}.`,
      { artifact: relativePath, expected },
    );
  }
}

export async function assertProtocolConformance({ root, overrides = {} }) {
  const projectRoot = resolve(root);
  const protocolSource = await source(projectRoot, ".agents/protocol.json");
  let protocol;
  try {
    protocol = JSON.parse(protocolSource);
  } catch (error) {
    throw new KernelError("conformance_invalid_manifest", `protocol.json inválido: ${error.message}`);
  }
  if (protocol.schemaVersion !== 2 || protocol.protocolVersion !== 2) {
    throw new KernelError("conformance_version_mismatch", "La distribución debe declarar protocolo 2.");
  }
  let installedDistributionVersion;
  try {
    installedDistributionVersion = (
      await readFile(join(projectRoot, ".agents", "VERSION"), "utf8")
    ).trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new KernelError(
        "conformance_invalid_manifest",
        `.agents/VERSION no es legible: ${error.message}`,
      );
    }
    const packageSource = await source(projectRoot, "package.json");
    let packageManifest;
    try {
      packageManifest = JSON.parse(packageSource);
    } catch (parseError) {
      throw new KernelError(
        "conformance_invalid_manifest",
        `package.json inválido: ${parseError.message}`,
      );
    }
    if (
      packageManifest.agentic?.protocolVersion !== 2 ||
      packageManifest.agentic?.distributionVersion !== packageManifest.version
    ) {
      throw new KernelError(
        "conformance_version_mismatch",
        "La fuente canónica debe alinear package.json.version y agentic.distributionVersion.",
      );
    }
    installedDistributionVersion = packageManifest.agentic.distributionVersion;
  }
  if (
    typeof protocol.distributionVersion !== "string" ||
    protocol.distributionVersion !== installedDistributionVersion
  ) {
    throw new KernelError(
      "conformance_version_mismatch",
      "protocol.json debe coincidir con la versión instalada de la distribución.",
      {
        installedDistributionVersion,
        protocolDistributionVersion: protocol.distributionVersion,
      },
    );
  }
  const retirementDate = protocol.v1Retirement?.date;
  const retirementTimestamp =
    typeof retirementDate === "string" ? Date.parse(`${retirementDate}T00:00:00Z`) : Number.NaN;
  if (
    typeof protocol.v1Retirement?.condition !== "string" ||
    !protocol.v1Retirement.condition.trim() ||
    typeof retirementDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(retirementDate) ||
    Number.isNaN(retirementTimestamp) ||
    new Date(retirementTimestamp).toISOString().slice(0, 10) !== retirementDate
  ) {
    throw new KernelError(
      "conformance_retirement_undefined",
      "El adapter v1 debe declarar fecha ISO y condición objetiva de retiro.",
    );
  }
  for (const artifact of [
    "adapters",
    "kernel",
    "policies",
    "roles",
    "schemas",
    "skill",
    "templates",
    "workflows",
  ]) {
    exactVersion(protocol, artifact);
  }
  for (const artifact of ["legacyAdapter", "legacyController"]) {
    if (protocol.artifacts?.[artifact] !== 1) {
      throw new KernelError(
        "conformance_version_mismatch",
        `${artifact} debe permanecer marcado como compatibilidad v1.`,
      );
    }
  }
  const allowed = new Set(protocol.allowedOverrides ?? []);
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key)) {
      throw new KernelError(
        "conformance_override_drift",
        `Override no permitido: ${key}. Permitidos: ${[...allowed].join(", ")}.`,
        { override: key },
      );
    }
  }
  if (
    Object.hasOwn(overrides, "contextBudgetBytes") &&
    (!Number.isInteger(overrides.contextBudgetBytes) || overrides.contextBudgetBytes < 1)
  ) {
    throw new KernelError(
      "conformance_override_invalid",
      "contextBudgetBytes debe ser un entero positivo.",
    );
  }
  if (
    Object.hasOwn(overrides, "protocolWriteVersion") &&
    ![1, 2].includes(overrides.protocolWriteVersion)
  ) {
    throw new KernelError(
      "conformance_override_invalid",
      "protocolWriteVersion debe ser 1 o 2 durante la ventana de compatibilidad.",
    );
  }
  if (
    Object.hasOwn(overrides, "telemetrySink") &&
    (typeof overrides.telemetrySink !== "string" || !overrides.telemetrySink.trim())
  ) {
    throw new KernelError(
      "conformance_override_invalid",
      "telemetrySink debe identificar un sink no vacío.",
    );
  }

  const artifacts = { ".agents/protocol.json": protocolSource };
  const policyPath = ".agents/policies/orquestacion.md";
  artifacts[policyPath] = await source(projectRoot, policyPath);
  marker(artifacts[policyPath], "<!-- agentic-protocol:v2 -->", policyPath);
  marker(artifacts[policyPath], "<!-- agentic-bootstrap-repair:v1 -->", policyPath);

  for (const role of ROLES) {
    const path = `.agents/roles/${role}.md`;
    artifacts[path] = await source(projectRoot, path);
    marker(artifacts[path], "<!-- agentic-role-report:v2 -->", path);
    for (const adapterPath of [`.codex/agents/${role}.toml`, `.claude/agents/${role}.md`]) {
      artifacts[adapterPath] = await source(projectRoot, adapterPath);
      marker(artifacts[adapterPath], "agentic-protocol:v2", adapterPath);
      if (
        !artifacts[adapterPath].includes("RoleReport") ||
        !artifacts[adapterPath].includes("contextPaths") ||
        /Usa [`]?\.agents\/scripts\/session-controller\.mjs/.test(artifacts[adapterPath])
      ) {
        throw new KernelError(
          "conformance_ownership_drift",
          `${adapterPath} no conserva WorkEnvelope → RoleReport con ownership del orquestador.`,
        );
      }
    }
  }
  const skillPath = ".agents/skills/orquestar/SKILL.md";
  artifacts[skillPath] = await source(projectRoot, skillPath);
  marker(artifacts[skillPath], "<!-- agentic-protocol:v2 -->", skillPath);
  for (const claudeEntrypoint of ["CLAUDE.md", ".claude/skills/orquestar/SKILL.md"]) {
    artifacts[claudeEntrypoint] = await source(projectRoot, claudeEntrypoint);
    marker(artifacts[claudeEntrypoint], "<!-- agentic-protocol:v2 -->", claudeEntrypoint);
    if (
      !artifacts[claudeEntrypoint].includes(".agents/kernel/orchestration-kernel.mjs") ||
      !artifacts[claudeEntrypoint].includes("compatibilidad") ||
      !artifacts[claudeEntrypoint].includes("v1")
    ) {
      throw new KernelError(
        "conformance_ownership_drift",
        `${claudeEntrypoint} no reserva el kernel v2 para sesiones nuevas y el controller para compatibilidad v1.`,
      );
    }
  }
  if (
    !artifacts[".claude/skills/orquestar/SKILL.md"].includes("WorkEnvelope") ||
    !artifacts[".claude/skills/orquestar/SKILL.md"].includes("RoleReport")
  ) {
    throw new KernelError(
      "conformance_ownership_drift",
      "El wrapper de Claude no conserva el seam WorkEnvelope → RoleReport.",
    );
  }
  for (const workflow of WORKFLOWS) {
    const path = `.agents/workflows/${workflow}.md`;
    artifacts[path] = await source(projectRoot, path);
    marker(artifacts[path], "<!-- agentic-workflow:v2 -->", path);
    if (workflow !== "architecture") {
      marker(artifacts[path], "<!-- agentic-light-sequence:v2 ", path);
      marker(artifacts[path], "<!-- agentic-light-sequence:v1 ", path);
    }
  }
  for (const template of ["dev-session.md", "subdev-session.md"]) {
    const path = `.agents/templates/${template}`;
    artifacts[path] = await source(projectRoot, path);
    marker(artifacts[path], "<!-- agentic-template:v2 -->", path);
  }
  for (const schema of SCHEMAS) {
    const path = `.agents/schemas/${schema}`;
    artifacts[path] = await source(projectRoot, path);
    const parsed = JSON.parse(artifacts[path]);
    if (parsed.properties?.schemaVersion?.const !== 2) {
      throw new KernelError("conformance_version_mismatch", `${path} no fija schemaVersion 2.`);
    }
  }
  const legacyControllerPath = ".agents/scripts/session-controller.mjs";
  artifacts[legacyControllerPath] = await source(projectRoot, legacyControllerPath);
  marker(
    artifacts[legacyControllerPath],
    "agentic-session-controller:v1-compatibility",
    legacyControllerPath,
  );

  for (const [relativePath, expectedMarker] of [
    [".agents/kernel/adapters.mjs", "agentic-adapters:v2"],
    [".agents/kernel/protocol-v2.mjs", "agentic-protocol-core:v2"],
    [".agents/kernel/v1-compatibility.mjs", "agentic-v1-compatibility-adapter:v1"],
  ]) {
    artifacts[relativePath] = await source(projectRoot, relativePath);
    marker(artifacts[relativePath], expectedMarker, relativePath);
  }

  const kernelPath = join(projectRoot, ".agents", "kernel", "orchestration-kernel.mjs");
  const kernelModule = await import(
    `${pathToFileURL(kernelPath).href}?conformance=${randomUUID()}`
  );
  const methods = Object.getOwnPropertyNames(kernelModule.OrchestrationKernel.prototype)
    .filter((name) => name !== "constructor")
    .sort();
  const expectedMethods = [...protocol.kernelInterface].sort();
  if (JSON.stringify(methods) !== JSON.stringify(expectedMethods)) {
    throw new KernelError(
      "conformance_kernel_interface_drift",
      `Interface del kernel divergente: actual=${methods.join(",")}; esperada=${expectedMethods.join(",")}.`,
      { actual: methods, expected: expectedMethods },
    );
  }
  artifacts[".agents/kernel/orchestration-kernel.mjs"] = await readFile(kernelPath, "utf8");
  marker(
    artifacts[".agents/kernel/orchestration-kernel.mjs"],
    "agentic-kernel:v2",
    ".agents/kernel/orchestration-kernel.mjs",
  );

  return {
    artifactHash: digestObject(artifacts),
    distributionVersion: protocol.distributionVersion,
    overrides: { ...overrides },
    protocolVersion: protocol.protocolVersion,
  };
}
