// agentic-adapters
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import {
  KernelError,
  clone,
  digestObject,
  redactEvent,
  stableJson,
  validateSessionId,
} from "./protocol.mjs";

export function createBootstrapCapability() {
  return Object.freeze(Object.create(null));
}

export class MemoryCapabilityRegistry {
  #entries = new Map();

  issue(sessionId, expiresAtMonotonic = Number.POSITIVE_INFINITY) {
    const capability = Object.freeze(Object.create(null));
    this.#entries.set(sessionId, { capability, expiresAtMonotonic });
    return capability;
  }

  authorize(sessionId, capability, nowMonotonic) {
    const entry = this.#entries.get(sessionId);
    return Boolean(
      entry && entry.capability === capability && nowMonotonic <= entry.expiresAtMonotonic,
    );
  }

  capabilityFor(sessionId) {
    return this.#entries.get(sessionId)?.capability;
  }

  revoke(sessionId) {
    this.#entries.delete(sessionId);
  }
}

export class SystemClock {
  nowUtc() {
    return new Date().toISOString();
  }

  nowMonotonic() {
    return performance.now();
  }
}

export class FakeClock {
  constructor({ utc = "2026-01-01T00:00:00.000Z", monotonicMs = 0 } = {}) {
    this.wallTimeMs = Date.parse(utc);
    this.monotonicMs = monotonicMs;
  }

  nowUtc() {
    return new Date(this.wallTimeMs).toISOString();
  }

  nowMonotonic() {
    return this.monotonicMs;
  }

  advance(milliseconds, { wallMilliseconds = milliseconds } = {}) {
    this.monotonicMs += milliseconds;
    this.wallTimeMs += wallMilliseconds;
  }
}

export class MemoryStateStore {
  constructor({ probeFailure } = {}) {
    this.snapshots = new Map();
    this.probeFailure = probeFailure;
    this.probeResidues = new Set();
    this.#globalTail = Promise.resolve();
    this.#sessionTails = new Map();
  }

  #globalTail;
  #sessionTails;

  async load(sessionId) {
    return clone(this.snapshots.get(sessionId));
  }

  async save(sessionId, snapshot) {
    this.snapshots.set(sessionId, clone(snapshot));
  }

  async findCommand(commandId) {
    for (const snapshot of this.snapshots.values()) {
      if (Object.hasOwn(snapshot.commands ?? {}, commandId)) {
        return { command: clone(snapshot.commands[commandId]), sessionId: snapshot.sessionId };
      }
    }
    return undefined;
  }

  async findActiveWriter() {
    for (const snapshot of this.snapshots.values()) {
      for (const attempt of Object.values(snapshot.attempts ?? {})) {
        if (attempt.state === "active" && attempt.permission === "writer") {
          return { attemptId: attempt.attemptId, sessionId: snapshot.sessionId };
        }
      }
    }
    return undefined;
  }

  async withGlobalLock(operation) {
    return this.#enqueue(
      () => this.#globalTail,
      (tail) => {
        this.#globalTail = tail;
      },
      operation,
    );
  }

  async withLock(sessionId, operation) {
    return this.#enqueue(
      () => this.#sessionTails.get(sessionId) ?? Promise.resolve(),
      (tail) => this.#sessionTails.set(sessionId, tail),
      operation,
    );
  }

  async #enqueue(getTail, setTail, operation) {
    const previous = getTail();
    let release;
    const current = new Promise((resolvePromise) => {
      release = resolvePromise;
    });
    setTail(previous.then(() => current));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async probe(sessionId) {
    const probeId = `${sessionId}:${randomUUID()}`;
    this.probeResidues.add(probeId);
    try {
      if (this.probeFailure) {
        const failure = this.probeFailure;
        throw Object.assign(new Error(failure.message ?? "Probe de memoria fallido."), {
          code: failure.code ?? "EPERM",
          operation: failure.operation ?? "write",
          path: failure.path ?? `memory://${sessionId}`,
          remedy: failure.remedy ?? "Corregir el adapter de estado.",
        });
      }
      return { lock: "ok", replace: "ok", store: "ok" };
    } finally {
      this.probeResidues.delete(probeId);
    }
  }
}

export class FileSystemStateStore {
  constructor({ root, directory = ".agents/sessions/state" }) {
    if (typeof root !== "string" || !root) throw new TypeError("root es obligatorio.");
    this.root = resolve(root);
    this.baseDirectory = resolve(this.root, directory);
    if (!this.baseDirectory.startsWith(`${this.root}${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new TypeError("El store debe permanecer dentro de root.");
    }
    this.eventSink = new JsonlEventSink({ path: join(this.baseDirectory, "events.jsonl") });
  }

  #sessionDirectory(sessionId) {
    validateSessionId(sessionId);
    return join(this.baseDirectory, sessionId);
  }

  #snapshotPath(sessionId) {
    return join(this.#sessionDirectory(sessionId), "snapshot.json");
  }

  async load(sessionId) {
    const path = this.#snapshotPath(sessionId);
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw new KernelError(
        error instanceof SyntaxError ? "state_snapshot_invalid" : "state_read_failed",
        `No se pudo leer el snapshot de ${sessionId}: ${error.message}`,
        {
          cause: error.code ?? error.name,
          operation: error instanceof SyntaxError ? "parse-snapshot" : "read-snapshot",
          path,
          remedy: "Restaurar un snapshot íntegro desde evidencia durable antes de continuar.",
        },
      );
    }
  }

  async save(sessionId, snapshot) {
    const target = this.#snapshotPath(sessionId);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${stableJson(snapshot)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } finally {
      try {
        await handle?.close();
        await rm(temporary, { force: true });
      } catch (error) {
        error.operation ??= "cleanup-snapshot-temporary";
        error.path ??= temporary;
        error.remedy ??= "Retirar el temporal residual y corregir permisos del store.";
        throw error;
      }
    }
  }

  async findCommand(commandId) {
    let entries;
    try {
      entries = await readdir(this.baseDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const snapshot = await this.load(entry.name);
      if (Object.hasOwn(snapshot?.commands ?? {}, commandId)) {
        return { command: snapshot.commands[commandId], sessionId: snapshot.sessionId };
      }
    }
    return undefined;
  }

  async findActiveWriter() {
    let entries;
    try {
      entries = await readdir(this.baseDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const snapshot = await this.load(entry.name);
      for (const attempt of Object.values(snapshot?.attempts ?? {})) {
        if (attempt.state === "active" && attempt.permission === "writer") {
          return { attemptId: attempt.attemptId, sessionId: snapshot.sessionId };
        }
      }
    }
    return undefined;
  }

  async withGlobalLock(operation) {
    return this.#withFileLock(join(this.baseDirectory, ".global.lock"), operation);
  }

  async withLock(sessionId, operation) {
    return this.#withFileLock(join(this.baseDirectory, `.session-${sessionId}.lock`), operation);
  }

  async #withFileLock(lockPath, operation) {
    await mkdir(dirname(lockPath), { recursive: true });
    const ownershipToken = `${process.pid}:${randomUUID()}`;
    let handle;
    let created = false;
    try {
      handle = await open(lockPath, "wx", 0o600);
      created = true;
      await handle.writeFile(ownershipToken, "utf8");
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) await rm(lockPath, { force: true }).catch(() => {});
      if (error.code === "EEXIST") {
        throw new KernelError("session_locked", `No se pudo adquirir el lock ${lockPath}.`, {
          operation: "lock",
          path: lockPath,
          remedy: "Finalizar o recuperar la mutación concurrente.",
        });
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      const observedToken = await readFile(lockPath, "utf8").catch(() => undefined);
      if (observedToken === ownershipToken) {
        await rm(lockPath, { force: true }).catch(() => {});
      }
    }
  }

  async probe(sessionId) {
    await mkdir(this.baseDirectory, { recursive: true });
    const stem = join(this.baseDirectory, `.probe-${sessionId}-${randomUUID()}`);
    const source = `${stem}.source`;
    const target = `${stem}.target`;
    const lock = `${stem}.lock`;
    let sourceHandle;
    let lockHandle;
    try {
      sourceHandle = await open(source, "wx", 0o600);
      await sourceHandle.writeFile("probe", "utf8");
      await sourceHandle.sync();
      await sourceHandle.close();
      sourceHandle = undefined;
      await rename(source, target);
      await rm(target);
      lockHandle = await open(lock, "wx", 0o600);
      await lockHandle.close();
      lockHandle = undefined;
      await rm(lock);
      return { lock: "ok", replace: "ok", store: "ok" };
    } catch (error) {
      error.operation ??= error.code === "EEXIST" ? "lock" : "write-replace-remove";
      error.path ??= stem;
      error.remedy ??= "Conceder escritura y locks atómicos al directorio del store.";
      throw error;
    } finally {
      await sourceHandle?.close().catch(() => {});
      await lockHandle?.close().catch(() => {});
      for (const path of [source, target, lock]) {
        try {
          await rm(path, { force: true });
        } catch (error) {
          error.operation ??= "cleanup-store-probe";
          error.path ??= path;
          error.remedy ??= "Retirar el probe residual y corregir permisos de limpieza.";
          throw error;
        }
      }
    }
  }
}

async function directoryWritable(path, label) {
  await mkdir(path, { recursive: true });
  await access(path, fsConstants.W_OK);
  const probe = join(path, `.agentic-probe-${randomUUID()}`);
  try {
    const handle = await open(probe, "wx", 0o600);
    await handle.close();
  } catch (error) {
    error.operation ??= `write-${label}`;
    error.path ??= path;
    throw error;
  } finally {
    try {
      await rm(probe, { force: true });
    } catch (error) {
      error.operation ??= `cleanup-${label}`;
      error.path ??= probe;
      error.remedy ??= "Retirar el probe residual y corregir permisos de limpieza.";
      throw error;
    }
  }
}

async function commandAvailable(command, environmentPath = process.env.PATH ?? "") {
  if (!command) return false;
  if (command.includes("/") || command.includes("\\")) {
    try {
      return (await stat(command)).isFile();
    } catch {
      return false;
    }
  }
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of environmentPath.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, extname(command) ? command : `${command}${extension}`);
      try {
        if ((await stat(candidate)).isFile()) return true;
      } catch {
        // Continuar con el siguiente candidato.
      }
    }
  }
  return false;
}

export class SystemEnvironmentProbe {
  constructor({ cacheDirectory, temporaryDirectory = tmpdir(), capabilities = {} } = {}) {
    this.cacheDirectory = cacheDirectory;
    this.temporaryDirectory = temporaryDirectory;
    this.capabilities = capabilities;
  }

  async run({ requirements = {}, sessionId, store }) {
    try {
      const storeChecks = await store.probe(sessionId);
      await directoryWritable(this.temporaryDirectory, "temporary");
      const cacheDirectory = this.cacheDirectory ?? this.temporaryDirectory;
      await directoryWritable(cacheDirectory, "cache");
      for (const command of requirements.commands ?? []) {
        if (!(await commandAvailable(command))) {
          return {
            ok: false,
            check: "command",
            operation: "resolve",
            path: command,
            remedy: `Instalar o declarar la ruta ejecutable de ${command}.`,
          };
        }
      }
      for (const capability of ["browser", "network"]) {
        if (requirements[capability] && !this.capabilities[capability]) {
          return {
            ok: false,
            check: capability,
            operation: "detect-capability",
            path: capability,
            remedy: `Habilitar la capacidad ${capability} antes de crear la sesión.`,
          };
        }
      }
      return {
        ok: true,
        cacheDirectory,
        checks: { ...storeChecks, cache: "ok", temporary: "ok" },
      };
    } catch (error) {
      return {
        ok: false,
        check: error.operation ?? "environment",
        code: error.code,
        operation: error.operation ?? "probe",
        path: error.path,
        remedy: error.remedy ?? "Corregir permisos o seleccionar un entorno escribible.",
      };
    }
  }
}

export class FakeEnvironmentProbe {
  constructor({ failure, report = {} } = {}) {
    this.failure = failure;
    this.report = report;
    this.calls = [];
    this.residuals = [];
  }

  async run(input) {
    this.calls.push(clone({ requirements: input.requirements, sessionId: input.sessionId }));
    if (this.failure) {
      return {
        ok: false,
        check: this.failure.check ?? "store",
        code: this.failure.code ?? "EPERM",
        operation: this.failure.operation ?? "write",
        path: this.failure.path ?? "fixture://store",
        remedy: this.failure.remedy ?? "Usar un store escribible.",
      };
    }
    return { ok: true, checks: { lock: "ok", store: "ok" }, ...clone(this.report) };
  }
}

export class MemoryEventSink {
  constructor({ failOnAppend = false, knownSecrets = [] } = {}) {
    this.events = [];
    this.failOnAppend = failOnAppend;
    this.knownSecrets = knownSecrets;
    this.eventIds = new Set();
  }

  async append(event) {
    if (this.failOnAppend) throw new Error("EventSink fixture failure");
    const safe = redactEvent(clone(event));
    const serialized = stableJson(safe);
    for (const secret of this.knownSecrets) {
      if (secret && serialized.includes(secret)) {
        throw new KernelError("telemetry_secret", "La telemetría contenía un secreto conocido.");
      }
    }
    if (this.eventIds.has(safe.eventId)) return { duplicate: true };
    this.eventIds.add(safe.eventId);
    this.events.push(safe);
    return { duplicate: false };
  }
}

export class JsonlEventSink {
  constructor({ path, knownSecrets = [] }) {
    this.path = path;
    this.knownSecrets = knownSecrets;
    this.eventIds = new Set();
  }

  async append(event) {
    const safe = redactEvent(clone(event));
    const line = stableJson(safe);
    for (const secret of this.knownSecrets) {
      if (secret && line.includes(secret)) {
        throw new KernelError("telemetry_secret", "La telemetría contenía un secreto conocido.");
      }
    }
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const existing = await readFile(this.path, "utf8");
      for (const candidate of existing.split(/\r?\n/).filter(Boolean)) {
        let parsed;
        try {
          parsed = JSON.parse(candidate);
        } catch (error) {
          throw new KernelError("event_log_invalid", `El event log contiene JSON truncado: ${error.message}`, {
            operation: "parse-event-log",
            path: this.path,
            remedy: "Restaurar o aislar el event log antes de continuar la telemetría.",
          });
        }
        if (typeof parsed.eventId !== "string" || !parsed.eventId) {
          throw new KernelError("event_log_invalid", "El event log contiene un evento sin eventId.", {
            operation: "parse-event-log",
            path: this.path,
            remedy: "Restaurar o aislar el event log antes de continuar la telemetría.",
          });
        }
        this.eventIds.add(parsed.eventId);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (this.eventIds.has(safe.eventId)) return { duplicate: true };
    await appendFile(this.path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    this.eventIds.add(safe.eventId);
    return { duplicate: false };
  }
}

export function validationFingerprint(evidence) {
  return digestObject({
    commands: evidence.commands,
    environmentFingerprint: evidence.environmentFingerprint,
    generation: evidence.generation,
    laneId: evidence.laneId,
    treeFingerprint: evidence.treeFingerprint,
  });
}
