import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { KernelError, digestObject } from "../kernel/protocol.mjs";

const ROLES = ["documentador", "evaluador", "explorador", "implementador", "planificador", "tester"];
const WORKFLOWS = ["architecture", "bugfix", "feature", "refactor"];
const SCHEMAS = [
  "acceptance-contract.schema.json",
  "role-report.schema.json",
  "session-event.schema.json",
  "validation-evidence.schema.json",
  "work-envelope.schema.json",
];
const ARTIFACT_GROUPS = [
  "adapters",
  "kernel",
  "policies",
  "roles",
  "schemas",
  "skill",
  "templates",
  "workflows",
];

async function source(root, relativePath) {
  try {
    return await readFile(join(root, ...relativePath.split("/")), "utf8");
  } catch (error) {
    throw new KernelError("conformance_missing_artifact", `Falta ${relativePath}: ${error.message}`);
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
  if (protocol.schemaVersion !== 3) {
    throw new KernelError("conformance_version_mismatch", "La distribución debe declarar schemaVersion 3.");
  }
  if (JSON.stringify(protocol.artifacts) !== JSON.stringify(ARTIFACT_GROUPS)) {
    throw new KernelError(
      "conformance_inventory_mismatch",
      "protocol.json no declara el inventario canónico de artefactos.",
    );
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
    if (packageManifest.agentic?.distributionVersion !== packageManifest.version) {
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
  marker(artifacts[policyPath], "<!-- agentic-protocol -->", policyPath);
  marker(artifacts[policyPath], "<!-- agentic-bootstrap-repair -->", policyPath);

  for (const role of ROLES) {
    const path = `.agents/roles/${role}.md`;
    artifacts[path] = await source(projectRoot, path);
    marker(artifacts[path], "<!-- agentic-role-report -->", path);
    for (const adapterPath of [`.codex/agents/${role}.toml`, `.claude/agents/${role}.md`]) {
      artifacts[adapterPath] = await source(projectRoot, adapterPath);
      marker(artifacts[adapterPath], "agentic-protocol", adapterPath);
      if (
        !artifacts[adapterPath].includes("RoleReport") ||
        !artifacts[adapterPath].includes("contextPaths")
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
  marker(artifacts[skillPath], "<!-- agentic-protocol -->", skillPath);
  for (const claudeEntrypoint of ["CLAUDE.md", ".claude/skills/orquestar/SKILL.md"]) {
    artifacts[claudeEntrypoint] = await source(projectRoot, claudeEntrypoint);
    marker(artifacts[claudeEntrypoint], "<!-- agentic-protocol -->", claudeEntrypoint);
    if (!artifacts[claudeEntrypoint].includes(".agents/kernel/orchestration-kernel.mjs")) {
      throw new KernelError(
        "conformance_ownership_drift",
        `${claudeEntrypoint} no reserva el runtime al kernel actual.`,
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
    marker(artifacts[path], "<!-- agentic-workflow -->", path);
    if (workflow !== "architecture") {
      marker(artifacts[path], "<!-- agentic-light-sequence ", path);
    }
  }
  for (const template of ["dev-session.md", "subdev-session.md"]) {
    const path = `.agents/templates/${template}`;
    artifacts[path] = await source(projectRoot, path);
    marker(artifacts[path], "<!-- agentic-template -->", path);
  }
  for (const schema of SCHEMAS) {
    const path = `.agents/schemas/${schema}`;
    artifacts[path] = await source(projectRoot, path);
    const parsed = JSON.parse(artifacts[path]);
    if (parsed.properties?.schemaVersion?.const !== 3) {
      throw new KernelError("conformance_version_mismatch", `${path} no fija schemaVersion 3.`);
    }
  }
  for (const [relativePath, expectedMarker] of [
    [".agents/kernel/adapters.mjs", "agentic-adapters"],
    [".agents/kernel/protocol.mjs", "agentic-protocol-core"],
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
    "agentic-kernel",
    ".agents/kernel/orchestration-kernel.mjs",
  );

  return {
    artifactHash: digestObject(artifacts),
    distributionVersion: protocol.distributionVersion,
    overrides: { ...overrides },
    schemaVersion: protocol.schemaVersion,
  };
}
