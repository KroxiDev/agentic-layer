import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import {
  normalizeProtocolOverrides,
  validateProtocolManifest,
} from "../kernel/protocol-manifest.mjs";
import { KernelError, SCHEMA_VERSION, digestObject } from "../kernel/protocol.mjs";

const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const JSON_SCHEMA_KEYWORDS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "description",
  "else",
  "enum",
  "format",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxLength",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minimum",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "then",
  "title",
  "type",
  "uniqueItems",
]);

async function source(root, relativePath) {
  try {
    return await readFile(join(root, ...relativePath.split("/")), "utf8");
  } catch (error) {
    throw new KernelError("conformance_missing_artifact", `Falta ${relativePath}: ${error.message}`, {
      artifact: relativePath,
    });
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

function requiredContent(content, expected, relativePath) {
  if (!content.includes(expected)) {
    throw new KernelError(
      "conformance_ownership_drift",
      `${relativePath} no conserva el contrato requerido: ${expected}.`,
      { artifact: relativePath, expected },
    );
  }
}

function schemaFailure(relativePath, message, details = {}) {
  throw new KernelError("conformance_schema_invalid", `${relativePath}: ${message}`, {
    artifact: relativePath,
    ...details,
  });
}

function validateSchemaNode(node, location, relativePath) {
  if (typeof node === "boolean") return;
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    schemaFailure(relativePath, `${location} debe ser un schema JSON.`);
  }
  const unknown = Object.keys(node).filter((keyword) => !JSON_SCHEMA_KEYWORDS.has(keyword));
  if (unknown.length) {
    schemaFailure(relativePath, `${location} usa keywords no soportados: ${unknown.join(", ")}.`);
  }
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (
      types.length === 0 ||
      new Set(types).size !== types.length ||
      types.some((type) => !JSON_SCHEMA_TYPES.has(type))
    ) {
      schemaFailure(relativePath, `${location}.type no es válido.`);
    }
  }
  if (node.enum !== undefined) {
    if (
      !Array.isArray(node.enum) ||
      node.enum.length === 0 ||
      new Set(node.enum.map((value) => JSON.stringify(value))).size !== node.enum.length
    ) {
      schemaFailure(relativePath, `${location}.enum debe contener valores únicos.`);
    }
  }
  if (node.required !== undefined) {
    if (
      !Array.isArray(node.required) ||
      new Set(node.required).size !== node.required.length ||
      node.required.some((key) => typeof key !== "string" || !key)
    ) {
      schemaFailure(relativePath, `${location}.required debe listar propiedades únicas.`);
    }
  }
  if (node.pattern !== undefined) {
    if (typeof node.pattern !== "string") schemaFailure(relativePath, `${location}.pattern debe ser string.`);
    try {
      new RegExp(node.pattern);
    } catch (error) {
      schemaFailure(relativePath, `${location}.pattern no compila: ${error.message}`);
    }
  }
  for (const keyword of ["$comment", "$id", "$ref", "$schema", "description", "format", "title"]) {
    if (node[keyword] !== undefined && typeof node[keyword] !== "string") {
      schemaFailure(relativePath, `${location}.${keyword} debe ser string.`);
    }
  }
  for (const keyword of ["maxContains", "maxItems", "maxLength", "minContains", "minItems", "minLength"]) {
    if (node[keyword] !== undefined && (!Number.isInteger(node[keyword]) || node[keyword] < 0)) {
      schemaFailure(relativePath, `${location}.${keyword} debe ser un entero no negativo.`);
    }
  }
  for (const keyword of ["maximum", "minimum"]) {
    if (node[keyword] !== undefined && typeof node[keyword] !== "number") {
      schemaFailure(relativePath, `${location}.${keyword} debe ser numérico.`);
    }
  }
  if (node.uniqueItems !== undefined && typeof node.uniqueItems !== "boolean") {
    schemaFailure(relativePath, `${location}.uniqueItems debe ser booleano.`);
  }
  for (const keyword of ["properties", "$defs"]) {
    if (node[keyword] !== undefined) {
      if (!node[keyword] || typeof node[keyword] !== "object" || Array.isArray(node[keyword])) {
        schemaFailure(relativePath, `${location}.${keyword} debe ser un objeto.`);
      }
      for (const [name, child] of Object.entries(node[keyword])) {
        validateSchemaNode(child, `${location}.${keyword}.${name}`, relativePath);
      }
    }
  }
  for (const keyword of ["additionalProperties", "contains", "else", "if", "items", "not", "then"]) {
    if (node[keyword] !== undefined) {
      validateSchemaNode(node[keyword], `${location}.${keyword}`, relativePath);
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (node[keyword] !== undefined) {
      if (!Array.isArray(node[keyword]) || node[keyword].length === 0) {
        schemaFailure(relativePath, `${location}.${keyword} debe ser una lista no vacía.`);
      }
      node[keyword].forEach((child, index) =>
        validateSchemaNode(child, `${location}.${keyword}[${index}]`, relativePath),
      );
    }
  }
}

function validateSchemaDocument(schema, artifact, schemaIds, schemaVersion) {
  const relativePath = artifact.path;
  validateSchemaNode(schema, "$", relativePath);
  if (schema.$schema !== JSON_SCHEMA_DRAFT) {
    schemaFailure(relativePath, `debe declarar ${JSON_SCHEMA_DRAFT}.`);
  }
  if (typeof schema.$id !== "string" || !schema.$id) {
    schemaFailure(relativePath, "debe declarar un $id no vacío.");
  }
  try {
    new URL(schema.$id);
  } catch {
    schemaFailure(relativePath, "$id debe ser una URL absoluta.");
  }
  if (schemaIds.has(schema.$id)) schemaFailure(relativePath, `$id duplicado: ${schema.$id}.`);
  schemaIds.add(schema.$id);
  if (schema.title !== artifact.schemaTitle) {
    schemaFailure(relativePath, `title debe ser ${artifact.schemaTitle}.`);
  }
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    schemaFailure(relativePath, "la raíz debe ser un objeto cerrado.");
  }
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    schemaFailure(relativePath, "la raíz debe declarar properties.");
  }
  if (!Array.isArray(schema.required) || !schema.required.includes("schemaVersion")) {
    schemaFailure(relativePath, "la raíz debe exigir schemaVersion.");
  }
  const missingProperties = schema.required.filter((name) => !Object.hasOwn(schema.properties, name));
  if (missingProperties.length) {
    schemaFailure(relativePath, `required referencia propiedades ausentes: ${missingProperties.join(", ")}.`);
  }
  if (schema.properties.schemaVersion?.const !== schemaVersion) {
    throw new KernelError(
      "conformance_version_mismatch",
      `${relativePath} no fija schemaVersion ${schemaVersion}.`,
      { artifact: relativePath },
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
  if (protocol.schemaVersion !== SCHEMA_VERSION) {
    throw new KernelError(
      "conformance_version_mismatch",
      `La distribución debe declarar schemaVersion ${SCHEMA_VERSION}.`,
    );
  }
  validateProtocolManifest(protocol);
  let installedDistributionVersion;
  let installedLayer = true;
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
    installedLayer = false;
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
  const allowed = new Set(Object.keys(protocol.configuration));
  const unsupported = Object.keys(overrides).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    throw new KernelError(
      "conformance_override_drift",
      `Override no permitido: ${unsupported.join(", ")}. Permitidos: ${[...allowed].join(", ")}.`,
      { overrides: unsupported },
    );
  }
  let normalizedOverrides;
  try {
    normalizedOverrides = normalizeProtocolOverrides(overrides, {
      includeDefaults: false,
      manifest: protocol,
    });
  } catch (error) {
    throw new KernelError("conformance_override_invalid", error.message);
  }

  const artifacts = { ".agents/protocol.json": protocolSource };
  const schemaIds = new Set();
  for (const artifact of protocol.artifacts) {
    if (artifact.path === ".agents/protocol.json") continue;
    const readablePath = installedLayer ? artifact.path : (artifact.source ?? artifact.path);
    const content = await source(projectRoot, readablePath);
    artifacts[artifact.path] = content;
    for (const expected of artifact.markers ?? []) marker(content, expected, artifact.path);
    for (const expected of artifact.contains ?? []) requiredContent(content, expected, artifact.path);
    if (artifact.kind === "schema") {
      let schema;
      try {
        schema = JSON.parse(content);
      } catch (error) {
        schemaFailure(artifact.path, `JSON inválido: ${error.message}`);
      }
      validateSchemaDocument(schema, artifact, schemaIds, protocol.schemaVersion);
    }
  }

  const kernelArtifacts = protocol.artifacts.filter((artifact) =>
    artifact.markers?.includes("agentic-kernel"),
  );
  if (kernelArtifacts.length !== 1) {
    throw new KernelError(
      "conformance_invalid_manifest",
      "El inventario debe identificar exactamente un kernel mediante agentic-kernel.",
    );
  }
  const kernelPath = join(projectRoot, ...kernelArtifacts[0].path.split("/"));
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
  return {
    artifactHash: digestObject(artifacts),
    distributionVersion: protocol.distributionVersion,
    overrides: normalizedOverrides,
    schemaVersion: protocol.schemaVersion,
  };
}
