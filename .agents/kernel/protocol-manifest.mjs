// agentic-protocol-manifest
import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { KernelError, SCHEMA_VERSION, deepFreeze } from "./protocol.mjs";

const ROOT_KEYS = new Set([
  "artifacts",
  "configuration",
  "distributionSupportFiles",
  "distributionVersion",
  "kernelInterface",
  "layerMarkers",
  "managedDirectories",
  "schemaVersion",
]);
const ARTIFACT_KEYS = new Set([
  "contains",
  "kind",
  "markers",
  "path",
  "schemaTitle",
  "source",
]);
function invalidManifest(message, details = {}) {
  throw new KernelError("conformance_invalid_manifest", message, details);
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidManifest(`${label} debe ser un objeto.`);
  }
}

function assertExactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    invalidManifest(`${label} contiene campos no admitidos: ${unexpected.join(", ")}.`);
  }
}

function assertUniqueStrings(value, label, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim()) ||
    new Set(value).size !== value.length
  ) {
    invalidManifest(`${label} debe ser una lista de strings no vacíos y únicos.`);
  }
}

function assertCanonicalPath(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    posix.normalize(value) !== value ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    invalidManifest(`${label} debe ser una ruta relativa canónica.`, { path: value });
  }
}

function validateConfigurationValue(name, specification, value) {
  if (specification.type === "integer") {
    if (!Number.isInteger(value) || value < specification.minimum) {
      throw new TypeError(`${name} debe ser un entero mayor o igual que ${specification.minimum}.`);
    }
    return value;
  }
  if (specification.type === "string") {
    if (typeof value !== "string" || value.trim().length < specification.minLength) {
      throw new TypeError(`${name} debe ser un string no vacío.`);
    }
    return value.trim();
  }
  throw new TypeError(`Tipo de configuración no soportado para ${name}: ${specification.type}.`);
}

function validateConfigurationSchema(configuration) {
  assertRecord(configuration, "configuration");
  if (Object.keys(configuration).length === 0) {
    invalidManifest("configuration debe declarar al menos un override.");
  }
  for (const [name, specification] of Object.entries(configuration)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
      invalidManifest(`Nombre de override no canónico: ${name}.`);
    }
    assertRecord(specification, `configuration.${name}`);
    if (specification.type === "integer") {
      assertExactKeys(specification, new Set(["default", "minimum", "type"]), `configuration.${name}`);
      if (!Number.isInteger(specification.minimum)) {
        invalidManifest(`configuration.${name}.minimum debe ser un entero.`);
      }
    } else if (specification.type === "string") {
      assertExactKeys(specification, new Set(["default", "minLength", "type"]), `configuration.${name}`);
      if (!Number.isInteger(specification.minLength) || specification.minLength < 1) {
        invalidManifest(`configuration.${name}.minLength debe ser un entero positivo.`);
      }
    } else {
      invalidManifest(`configuration.${name}.type no está soportado.`);
    }
    if (Object.hasOwn(specification, "default")) {
      try {
        validateConfigurationValue(name, specification, specification.default);
      } catch (error) {
        invalidManifest(`Default inválido para ${name}: ${error.message}`);
      }
    }
  }
}

export function validateProtocolManifest(manifest) {
  assertRecord(manifest, "protocol.json");
  assertExactKeys(manifest, ROOT_KEYS, "protocol.json");
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    invalidManifest(`protocol.json debe declarar schemaVersion ${SCHEMA_VERSION}.`);
  }
  if (
    typeof manifest.distributionVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(manifest.distributionVersion)
  ) {
    invalidManifest("distributionVersion debe ser SemVer.");
  }
  assertUniqueStrings(manifest.kernelInterface, "kernelInterface");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    invalidManifest("artifacts debe declarar el inventario instalado completo.");
  }

  const paths = new Set();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const label = `artifacts[${index}]`;
    assertRecord(artifact, label);
    assertExactKeys(artifact, ARTIFACT_KEYS, label);
    assertCanonicalPath(artifact.path, `${label}.path`);
    if (paths.has(artifact.path)) invalidManifest(`Artefacto duplicado: ${artifact.path}.`);
    paths.add(artifact.path);
    if (typeof artifact.kind !== "string" || !/^[a-z][a-z-]*$/.test(artifact.kind)) {
      invalidManifest(`${label}.kind debe ser un identificador canónico.`);
    }
    if (artifact.source !== undefined) assertCanonicalPath(artifact.source, `${label}.source`);
    if (artifact.markers !== undefined) {
      assertUniqueStrings(artifact.markers, `${label}.markers`, { allowEmpty: true });
    }
    if (artifact.contains !== undefined) {
      assertUniqueStrings(artifact.contains, `${label}.contains`, { allowEmpty: true });
    }
    if (artifact.kind === "schema") {
      if (typeof artifact.schemaTitle !== "string" || !artifact.schemaTitle.trim()) {
        invalidManifest(`${label}.schemaTitle es obligatorio para un schema.`);
      }
    } else if (artifact.schemaTitle !== undefined) {
      invalidManifest(`${label}.schemaTitle solo aplica a schemas.`);
    }
  }
  if (!paths.has(".agents/protocol.json")) {
    invalidManifest("El inventario debe incluir .agents/protocol.json.");
  }

  assertUniqueStrings(manifest.layerMarkers, "layerMarkers");
  for (const marker of manifest.layerMarkers) {
    assertCanonicalPath(marker, "layerMarkers[]");
    if (!paths.has(marker)) invalidManifest(`Layer marker fuera del inventario: ${marker}.`);
  }
  assertUniqueStrings(manifest.managedDirectories, "managedDirectories");
  for (const directory of manifest.managedDirectories) {
    assertCanonicalPath(directory, "managedDirectories[]");
  }
  assertUniqueStrings(manifest.distributionSupportFiles, "distributionSupportFiles");
  for (const path of manifest.distributionSupportFiles) {
    assertCanonicalPath(path, "distributionSupportFiles[]");
  }
  validateConfigurationSchema(manifest.configuration);
  return manifest;
}

export function normalizeProtocolOverrides(
  overrides = {},
  { includeDefaults = true, manifest = PROTOCOL_MANIFEST } = {},
) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("configuration debe ser un objeto.");
  }
  const unsupported = Object.keys(overrides).filter(
    (name) => !Object.hasOwn(manifest.configuration, name),
  );
  if (unsupported.length) {
    throw new TypeError(`configuration contiene campos no admitidos: ${unsupported.join(", ")}.`);
  }
  const normalized = {};
  for (const [name, specification] of Object.entries(manifest.configuration)) {
    if (Object.hasOwn(overrides, name)) {
      normalized[name] = validateConfigurationValue(name, specification, overrides[name]);
    } else if (includeDefaults && Object.hasOwn(specification, "default")) {
      normalized[name] = specification.default;
    }
  }
  return normalized;
}

export function protocolArtifactPaths(manifest = PROTOCOL_MANIFEST) {
  return manifest.artifacts.map((artifact) => artifact.path);
}

export function protocolAssetSources(manifest = PROTOCOL_MANIFEST) {
  return new Map(
    manifest.artifacts
      .filter((artifact) => artifact.source)
      .map((artifact) => [artifact.path, artifact.source]),
  );
}

export function protocolPackageFiles(manifest = PROTOCOL_MANIFEST) {
  return [
    ...manifest.artifacts.map((artifact) => artifact.source ?? artifact.path),
    ...manifest.distributionSupportFiles,
  ].sort();
}

export function protocolRoleNames(manifest = PROTOCOL_MANIFEST) {
  return manifest.artifacts
    .filter((artifact) => artifact.kind === "role")
    .map((artifact) => posix.basename(artifact.path, ".md"));
}

const manifestSource = readFileSync(new URL("../protocol.json", import.meta.url), "utf8");
export const PROTOCOL_MANIFEST = deepFreeze(validateProtocolManifest(JSON.parse(manifestSource)));
