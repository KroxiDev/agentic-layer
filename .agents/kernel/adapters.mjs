// agentic-adapters
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import {
  KernelError,
  SCHEMA_VERSION,
  assertOpaqueIdentifier,
  clone,
  digestObject,
  redactEvent,
  stableJson,
  validateSessionId,
} from "./protocol.mjs";

const WRITER_TERMINAL_STATES = new Set(["completed", "failed"]);
const ABANDONED_PROCESS_ERRORS = new Set(["EINVAL", "ESRCH"]);

function sameWriterOwner(left, right) {
  return Boolean(
    left &&
      right &&
      left.attempt === right.attempt &&
      left.session === right.session &&
      left.workingTreeId === right.workingTreeId,
  );
}

function validateWriterOwner(owner, workingTreeId) {
  if (
    !owner ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    Object.keys(owner).sort().join(",") !== "attempt,session,workingTreeId" ||
    owner.workingTreeId !== workingTreeId ||
    !/^[a-f0-9]{64}$/.test(workingTreeId)
  ) {
    throw new KernelError("writer_owner_invalid", "El propietario del writer no coincide con el store.");
  }
  try {
    assertOpaqueIdentifier(owner.attempt, "writer.owner.attempt");
    validateSessionId(owner.session);
  } catch (error) {
    throw new KernelError("writer_owner_invalid", "El propietario del writer no es válido.", {
      cause: error.code ?? error.name,
    });
  }
}

function validateWriterCheckpoint(checkpoint) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint) ||
    Object.keys(checkpoint).sort().join(",") !== "commandFingerprint,commandId,expectedRevision" ||
    !/^sha256:[a-f0-9]{64}$/.test(checkpoint.commandFingerprint) ||
    !Number.isInteger(checkpoint.expectedRevision) ||
    checkpoint.expectedRevision < 0
  ) {
    throw new KernelError("writer_checkpoint_invalid", "El checkpoint del writer no es demostrable.");
  }
  try {
    assertOpaqueIdentifier(checkpoint.commandId, "writer.checkpoint.commandId");
  } catch (error) {
    throw new KernelError("writer_checkpoint_invalid", "El checkpoint del writer no es válido.", {
      cause: error.code ?? error.name,
    });
  }
}

function writerReservation(owner, checkpoint) {
  return {
    schemaVersion: SCHEMA_VERSION,
    checkpoint: clone(checkpoint),
    owner: clone(owner),
  };
}

function validateWriterReservation(reservation, workingTreeId) {
  if (
    !reservation ||
    typeof reservation !== "object" ||
    Array.isArray(reservation) ||
    Object.keys(reservation).sort().join(",") !== "checkpoint,owner,schemaVersion" ||
    reservation.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new KernelError("writer_lock_ambiguous", "La reserva del writer no es interpretable.");
  }
  try {
    validateWriterOwner(reservation.owner, workingTreeId);
    validateWriterCheckpoint(reservation.checkpoint);
  } catch (error) {
    throw new KernelError("writer_lock_ambiguous", "La reserva del writer no es interpretable.", {
      cause: error.code ?? error.name,
      remedy: "Recuperar únicamente desde un snapshot o checkpoint con propietario exacto.",
    });
  }
  return reservation;
}

function terminalWriterIsProven(snapshot, reservation) {
  const { checkpoint, owner } = reservation;
  const attempt = snapshot?.attempts?.[owner.attempt];
  const dispatchCommand = snapshot?.commands?.[checkpoint.commandId];
  return Boolean(
    snapshot?.sessionId === owner.session &&
      attempt?.attemptId === owner.attempt &&
      attempt.permission === "writer" &&
      attempt.envelope?.sourceRevision === checkpoint.expectedRevision &&
      WRITER_TERMINAL_STATES.has(attempt.state) &&
      dispatchCommand?.fingerprint === checkpoint.commandFingerprint &&
      dispatchCommand.result?.envelope?.attemptId === owner.attempt,
  );
}

function processState(pid) {
  try {
    process.kill(pid, 0);
    return "active";
  } catch (error) {
    if (error.code === "EPERM") return "active";
    if (ABANDONED_PROCESS_ERRORS.has(error.code)) return "abandoned";
    return "ambiguous";
  }
}

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
  constructor({ probeFailure, workingTreeId } = {}) {
    this.snapshots = new Map();
    this.probeFailure = probeFailure;
    this.probeResidues = new Set();
    this.writerReservation = undefined;
    const resolvedWorkingTreeId =
      workingTreeId ?? digestObject(`memory-working-tree:${randomUUID()}`).slice("sha256:".length);
    if (!/^[a-f0-9]{64}$/.test(resolvedWorkingTreeId)) {
      throw new TypeError("workingTreeId debe ser un digest hexadecimal de 64 caracteres.");
    }
    Object.defineProperty(this, "workingTreeIdValue", { value: resolvedWorkingTreeId });
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
    if (this.writerReservation) return clone(this.writerReservation.owner);
    for (const snapshot of this.snapshots.values()) {
      for (const attempt of Object.values(snapshot.attempts ?? {})) {
        if (attempt.state === "active" && attempt.permission === "writer") {
          return {
            attempt: attempt.attemptId,
            session: snapshot.sessionId,
            workingTreeId: this.workingTreeIdValue,
          };
        }
      }
    }
    return undefined;
  }

  async workingTreeId() {
    return this.workingTreeIdValue;
  }

  async acquireWriter(owner, checkpoint) {
    validateWriterOwner(owner, this.workingTreeIdValue);
    validateWriterCheckpoint(checkpoint);
    const candidate = writerReservation(owner, checkpoint);
    if (!this.writerReservation) {
      this.writerReservation = candidate;
      return { recovered: false };
    }
    if (stableJson(this.writerReservation) === stableJson(candidate)) return { recovered: true };
    if (!sameWriterOwner(this.writerReservation.owner, owner)) {
      throw new KernelError(
        "writer_locked",
        `El working tree ya tiene un writer activo: ` +
          `${this.writerReservation.owner.session}/${this.writerReservation.owner.attempt}.`,
        clone(this.writerReservation.owner),
      );
    }
    throw new KernelError(
      "writer_checkpoint_conflict",
      "La reserva pertenece al intento, pero no al mismo checkpoint.",
      clone(this.writerReservation.owner),
    );
  }

  async releaseWriter(owner, { preserveForeignOwner = false } = {}) {
    validateWriterOwner(owner, this.workingTreeIdValue);
    if (!this.writerReservation) return false;
    if (!sameWriterOwner(this.writerReservation.owner, owner)) {
      if (preserveForeignOwner) return false;
      throw new KernelError(
        "writer_lock_conflict",
        "La reserva del writer pertenece a otro intento.",
        clone(this.writerReservation.owner),
      );
    }
    if (!terminalWriterIsProven(this.snapshots.get(owner.session), this.writerReservation)) {
      throw new KernelError(
        "writer_recovery_unproven",
        "El snapshot no demuestra que el intento propietario haya terminado.",
        clone(owner),
      );
    }
    this.writerReservation = undefined;
    return true;
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
    const resolvedRoot = resolve(root);
    const baseDirectory = resolve(resolvedRoot, directory);
    const relativeBase = relative(resolvedRoot, baseDirectory);
    if (
      !relativeBase ||
      relativeBase === ".." ||
      relativeBase.startsWith(`..${sep}`) ||
      isAbsolute(relativeBase)
    ) {
      throw new TypeError("El store debe permanecer dentro de root.");
    }
    Object.defineProperties(this, {
      baseDirectory: { enumerable: true, value: baseDirectory },
      root: { enumerable: true, value: resolvedRoot },
    });
    const eventPath = join(baseDirectory, "events.jsonl");
    const eventSink = new JsonlEventSink({
      path: eventPath,
      prepare: (handle) =>
        handle
          ? this.#verifyOpenFile(eventPath, handle, { operation: "append-event-log" })
          : this.#prepareFile(eventPath, { createParent: true, operation: "append-event-log" }),
    });
    Object.defineProperty(this, "eventSink", { enumerable: true, value: eventSink });
  }

  #sessionDirectory(sessionId) {
    validateSessionId(sessionId);
    return join(this.baseDirectory, sessionId);
  }

  #snapshotPath(sessionId) {
    return join(this.#sessionDirectory(sessionId), "snapshot.json");
  }

  #unsafePath(path, operation, cause) {
    throw new KernelError(
      "state_path_unsafe",
      `No se pudo demostrar que ${path} permanezca físicamente dentro de root.`,
      {
        ...(cause ? { cause: cause.code ?? cause.name } : {}),
        operation,
        path,
        remedy: "Retirar enlaces, junctions o ancestros ambiguos y reintentar sin escribir fuera de root.",
        root: this.root,
      },
    );
  }

  #relativePath(path, operation) {
    const absolute = resolve(path);
    const candidate = relative(this.root, absolute);
    if (
      candidate === ".." ||
      candidate.startsWith(`..${sep}`) ||
      isAbsolute(candidate)
    ) {
      this.#unsafePath(absolute, operation);
    }
    return candidate;
  }

  async #realRoot(operation) {
    let information;
    try {
      information = await lstat(this.root);
      if (information.isSymbolicLink() || !information.isDirectory()) {
        this.#unsafePath(this.root, operation);
      }
      return await realpath(this.root);
    } catch (error) {
      if (error instanceof KernelError) throw error;
      this.#unsafePath(this.root, operation, error);
    }
  }

  async #ensureSafeDirectory(path, { create = false, operation = "access-state" } = {}) {
    const relativePath = this.#relativePath(path, operation);
    const rootRealPath = await this.#realRoot(operation);
    if (!relativePath) return true;
    let current = this.root;
    for (const segment of relativePath.split(sep)) {
      current = join(current, segment);
      let information;
      try {
        information = await lstat(current);
      } catch (error) {
        if (error.code !== "ENOENT") this.#unsafePath(current, operation, error);
        if (!create) return false;
        try {
          await mkdir(current);
        } catch (mkdirError) {
          if (mkdirError.code !== "EEXIST") this.#unsafePath(current, operation, mkdirError);
        }
        try {
          information = await lstat(current);
        } catch (lstatError) {
          this.#unsafePath(current, operation, lstatError);
        }
      }
      if (information.isSymbolicLink() || !information.isDirectory()) {
        this.#unsafePath(current, operation);
      }
      let currentRealPath;
      try {
        currentRealPath = await realpath(current);
      } catch (error) {
        this.#unsafePath(current, operation, error);
      }
      const physicalRelative = relative(rootRealPath, currentRealPath);
      if (
        physicalRelative === ".." ||
        physicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(physicalRelative)
      ) {
        this.#unsafePath(current, operation);
      }
    }
    return true;
  }

  async #assertSafeFile(
    path,
    { allowMissing = true, allowMultipleLinks = false, operation = "access-state" } = {},
  ) {
    const parentExists = await this.#ensureSafeDirectory(dirname(path), { operation });
    if (!parentExists) return false;
    let information;
    try {
      information = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissing) return false;
      this.#unsafePath(path, operation, error);
    }
    if (
      information.isSymbolicLink() ||
      !information.isFile() ||
      (!allowMultipleLinks && information.nlink !== 1)
    ) {
      this.#unsafePath(path, operation);
    }
    const rootRealPath = await this.#realRoot(operation);
    let fileRealPath;
    try {
      fileRealPath = await realpath(path);
    } catch (error) {
      this.#unsafePath(path, operation, error);
    }
    const physicalRelative = relative(rootRealPath, fileRealPath);
    if (
      physicalRelative === ".." ||
      physicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(physicalRelative)
    ) {
      this.#unsafePath(path, operation);
    }
    return information;
  }

  async #verifyOpenFile(
    path,
    handle,
    { allowMultipleLinks = false, operation = "access-state" } = {},
  ) {
    const pathInformation = await this.#assertSafeFile(path, {
      allowMissing: false,
      allowMultipleLinks,
      operation,
    });
    const handleInformation = await handle.stat();
    if (
      !handleInformation.isFile() ||
      (!allowMultipleLinks && handleInformation.nlink !== 1) ||
      handleInformation.dev !== pathInformation.dev ||
      handleInformation.ino !== pathInformation.ino
    ) {
      this.#unsafePath(path, operation);
    }
    return handleInformation;
  }

  async #readSafeText(path, operation, { allowMultipleLinks = false } = {}) {
    if (!(await this.#assertSafeFile(path, { allowMultipleLinks, operation }))) return undefined;
    let handle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      await this.#verifyOpenFile(path, handle, { allowMultipleLinks, operation });
      return await handle.readFile("utf8");
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      if (error instanceof KernelError) throw error;
      if (error.code === "ELOOP") this.#unsafePath(path, operation, error);
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #openExclusive(path, operation) {
    await this.#prepareFile(path, { createParent: true, operation });
    let handle;
    try {
      handle = await open(
        path,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await this.#verifyOpenFile(path, handle, { operation });
      return handle;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code === "ELOOP") this.#unsafePath(path, operation, error);
      throw error;
    }
  }

  async #prepareFile(path, { createParent = false, operation = "access-state" } = {}) {
    await this.#ensureSafeDirectory(dirname(path), { create: createParent, operation });
    return this.#assertSafeFile(path, { operation });
  }

  async #removeSafeFile(
    path,
    { allowMultipleLinks = false, operation = "remove-state-file" } = {},
  ) {
    if (!(await this.#assertSafeFile(path, { allowMultipleLinks, operation }))) return false;
    try {
      await rm(path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async load(sessionId) {
    const path = this.#snapshotPath(sessionId);
    try {
      const source = await this.#readSafeText(path, "read-snapshot");
      return source === undefined ? undefined : JSON.parse(source);
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      if (error.code === "state_path_unsafe") throw error;
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
    await this.#ensureSafeDirectory(dirname(target), {
      create: true,
      operation: "write-snapshot",
    });
    await this.#assertSafeFile(target, { operation: "replace-snapshot" });
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await this.#openExclusive(temporary, "write-snapshot-temporary");
      await handle.writeFile(`${stableJson(snapshot)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#ensureSafeDirectory(dirname(target), { operation: "replace-snapshot" });
      await this.#assertSafeFile(target, { operation: "replace-snapshot" });
      await rename(temporary, target);
      await this.#assertSafeFile(target, { allowMissing: false, operation: "replace-snapshot" });
    } finally {
      try {
        await handle?.close();
        await this.#removeSafeFile(temporary, { operation: "cleanup-snapshot-temporary" });
      } catch (error) {
        error.operation ??= "cleanup-snapshot-temporary";
        error.path ??= temporary;
        error.remedy ??= "Retirar el temporal residual y corregir permisos del store.";
        throw error;
      }
    }
  }

  async findCommand(commandId) {
    const entries = await this.#sessionEntries();
    for (const entry of entries) {
      const snapshot = await this.load(entry.name);
      if (Object.hasOwn(snapshot?.commands ?? {}, commandId)) {
        return { command: snapshot.commands[commandId], sessionId: snapshot.sessionId };
      }
    }
    return undefined;
  }

  async findActiveWriter() {
    const reservation = await this.#readWriterReservation();
    if (reservation) return clone(reservation.owner);
    const workingTreeId = await this.workingTreeId();
    const entries = await this.#sessionEntries();
    for (const entry of entries) {
      const snapshot = await this.load(entry.name);
      for (const attempt of Object.values(snapshot?.attempts ?? {})) {
        if (attempt.state === "active" && attempt.permission === "writer") {
          return {
            attempt: attempt.attemptId,
            session: snapshot.sessionId,
            workingTreeId,
          };
        }
      }
    }
    return undefined;
  }

  async #sessionEntries() {
    if (!(await this.#ensureSafeDirectory(this.baseDirectory))) return [];
    const entries = await readdir(this.baseDirectory, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(this.baseDirectory, entry.name);
      if (entry.isSymbolicLink()) this.#unsafePath(path, "enumerate-snapshots");
      if (!entry.isDirectory()) continue;
      validateSessionId(entry.name);
      await this.#ensureSafeDirectory(path, { operation: "enumerate-snapshots" });
      sessions.push(entry);
    }
    return sessions;
  }

  async workingTreeId() {
    const canonicalRoot = (await this.#realRoot("identify-working-tree")).replaceAll("\\", "/");
    const portableRoot = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
    return digestObject(portableRoot).slice("sha256:".length);
  }

  async #writerLockPath() {
    return join(this.baseDirectory, `.writer-${await this.workingTreeId()}.lock`);
  }

  async #readWriterReservation() {
    const workingTreeId = await this.workingTreeId();
    const path = await this.#writerLockPath();
    let source;
    try {
      source = await this.#readSafeText(path, "read-writer-reservation", {
        allowMultipleLinks: true,
      });
      if (source === undefined) return undefined;
      return validateWriterReservation(JSON.parse(source), workingTreeId);
    } catch (error) {
      if (error.code === "state_path_unsafe") throw error;
      if (error.code === "writer_lock_ambiguous") {
        throw new KernelError(error.code, error.message, {
          ...error.details,
          operation: "read-writer-reservation",
          path,
          remedy: "Recuperar únicamente desde un snapshot o checkpoint con propietario exacto.",
        });
      }
      throw new KernelError("writer_lock_ambiguous", "La reserva del writer no es interpretable.", {
        cause: error.code ?? error.name,
        operation: "read-writer-reservation",
        path,
        remedy: "Recuperar únicamente desde un snapshot o checkpoint con propietario exacto.",
      });
    }
  }

  async #removeWriterCandidates(lockPath) {
    const prefix = `${lockPath}.tmp-`;
    const entries = await readdir(dirname(lockPath), { withFileTypes: true });
    for (const entry of entries) {
      const candidatePath = join(dirname(lockPath), entry.name);
      if (!candidatePath.startsWith(prefix)) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        this.#unsafePath(candidatePath, "cleanup-writer-candidate");
      }
      await this.#assertSafeFile(candidatePath, {
        allowMultipleLinks: true,
        operation: "cleanup-writer-candidate",
      });
      await this.#removeSafeFile(candidatePath, {
        allowMultipleLinks: true,
        operation: "cleanup-writer-candidate",
      });
    }
  }

  async acquireWriter(owner, checkpoint) {
    const workingTreeId = await this.workingTreeId();
    validateWriterOwner(owner, workingTreeId);
    validateWriterCheckpoint(checkpoint);
    await this.#ensureSafeDirectory(this.baseDirectory, {
      create: true,
      operation: "acquire-writer",
    });
    const lockPath = await this.#writerLockPath();
    await this.#removeWriterCandidates(lockPath);
    const candidate = writerReservation(owner, checkpoint);
    const candidatePath = `${lockPath}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await this.#openExclusive(candidatePath, "publish-writer-candidate");
      await handle.writeFile(stableJson(candidate), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(candidatePath, lockPath);
        return { recovered: false };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const observed = await this.#readWriterReservation();
      if (stableJson(observed) === stableJson(candidate)) return { recovered: true };
      if (!sameWriterOwner(observed.owner, owner)) {
        throw new KernelError(
          "writer_locked",
          `El working tree ya tiene un writer activo: ${observed.owner.session}/${observed.owner.attempt}.`,
          clone(observed.owner),
        );
      }
      throw new KernelError(
        "writer_checkpoint_conflict",
        "La reserva pertenece al intento, pero no al mismo checkpoint.",
        clone(observed.owner),
      );
    } finally {
      await handle?.close().catch(() => {});
      await this.#removeSafeFile(candidatePath, {
        allowMultipleLinks: true,
        operation: "cleanup-writer-candidate",
      }).catch(() => {});
    }
  }

  async releaseWriter(owner, { preserveForeignOwner = false } = {}) {
    const workingTreeId = await this.workingTreeId();
    validateWriterOwner(owner, workingTreeId);
    const lockPath = await this.#writerLockPath();
    const observed = await this.#readWriterReservation();
    if (!observed) return false;
    if (!sameWriterOwner(observed.owner, owner)) {
      if (preserveForeignOwner) return false;
      throw new KernelError(
        "writer_lock_conflict",
        "La reserva del writer pertenece a otro intento.",
        clone(observed.owner),
      );
    }
    const snapshot = await this.load(owner.session);
    if (!terminalWriterIsProven(snapshot, observed)) {
      throw new KernelError(
        "writer_recovery_unproven",
        "El snapshot no demuestra que el intento propietario haya terminado.",
        clone(owner),
      );
    }
    const expected = stableJson(observed);
    const currentSource = await this.#readSafeText(lockPath, "release-writer", {
      allowMultipleLinks: true,
    });
    if (currentSource === undefined) return false;
    let current;
    try {
      current = validateWriterReservation(JSON.parse(currentSource), workingTreeId);
    } catch (error) {
      if (error.code === "writer_lock_ambiguous") throw error;
      throw new KernelError("writer_lock_ambiguous", "La reserva del writer no es interpretable.");
    }
    if (stableJson(current) !== expected) {
      if (preserveForeignOwner) return false;
      throw new KernelError("writer_lock_conflict", "La reserva cambió durante su liberación.");
    }
    await this.#removeSafeFile(lockPath, {
      allowMultipleLinks: true,
      operation: "release-writer",
    });
    return true;
  }

  async withGlobalLock(operation) {
    return this.#withFileLock(join(this.baseDirectory, ".global.lock"), operation);
  }

  async withLock(sessionId, operation) {
    return this.#withFileLock(join(this.baseDirectory, `.session-${sessionId}.lock`), operation);
  }

  async #inspectMutationLock(lockPath) {
    const source = await this.#readSafeText(lockPath, "inspect-mutation-lock", {
      allowMultipleLinks: true,
    });
    if (source === undefined) return undefined;
    try {
      const owner = JSON.parse(source);
      if (
        !owner ||
        typeof owner !== "object" ||
        Array.isArray(owner) ||
        Object.keys(owner).sort().join(",") !== "pid,token" ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        typeof owner.token !== "string" ||
        !owner.token
      ) {
        throw new Error("invalid mutation lock");
      }
      return {
        owner,
        source,
        state: processState(owner.pid),
      };
    } catch {
      return { source, state: "ambiguous" };
    }
  }

  async #removeMutationCandidates(lockPath) {
    const prefix = `${lockPath}.tmp-`;
    const entries = await readdir(dirname(lockPath), { withFileTypes: true });
    for (const entry of entries) {
      const candidatePath = join(dirname(lockPath), entry.name);
      if (!candidatePath.startsWith(prefix)) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        this.#unsafePath(candidatePath, "cleanup-mutation-candidate");
      }
      const candidate = await this.#inspectMutationLock(candidatePath);
      if (candidate?.state === "active") continue;
      await this.#removeSafeFile(candidatePath, {
        allowMultipleLinks: true,
        operation: "cleanup-mutation-candidate",
      });
    }
  }

  async #publishMutationLock(lockPath, owner) {
    const candidatePath = `${lockPath}.tmp-${owner.pid}-${owner.token}`;
    let handle;
    try {
      handle = await this.#openExclusive(candidatePath, "publish-mutation-lock");
      await handle.writeFile(stableJson(owner), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(candidatePath, lockPath);
    } finally {
      await handle?.close().catch(() => {});
      await this.#removeSafeFile(candidatePath, {
        allowMultipleLinks: true,
        operation: "cleanup-mutation-candidate",
      }).catch(() => {});
    }
  }

  async #acquireMutationLock(lockPath, owner) {
    await this.#removeMutationCandidates(lockPath);
    try {
      await this.#publishMutationLock(lockPath, owner);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const observed = await this.#inspectMutationLock(lockPath);
    if (!observed || observed.state === "active") {
      throw new KernelError("session_locked", `No se pudo adquirir el lock ${lockPath}.`, {
        ...(observed?.owner ? { owner: observed.owner } : {}),
        operation: "lock",
        path: lockPath,
        remedy: "Finalizar la mutación propietaria antes de reintentar.",
      });
    }
    if (observed.state === "ambiguous") {
      throw new KernelError("session_lock_ambiguous", `El lock ${lockPath} no es recuperable.`, {
        operation: "recover-lock",
        path: lockPath,
        remedy: "Aportar evidencia atribuible del propietario; no borrar el lock por antigüedad.",
      });
    }
    const currentSource = await this.#readSafeText(lockPath, "recover-mutation-lock", {
      allowMultipleLinks: true,
    });
    if (currentSource !== observed.source) {
      throw new KernelError("session_locked", "El lock cambió durante su recuperación.");
    }
    await this.#removeSafeFile(lockPath, {
      allowMultipleLinks: true,
      operation: "recover-mutation-lock",
    });
    try {
      await this.#publishMutationLock(lockPath, owner);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new KernelError("session_locked", `No se pudo adquirir el lock ${lockPath}.`);
      }
      throw error;
    }
  }

  async #withFileLock(lockPath, operation) {
    await this.#ensureSafeDirectory(dirname(lockPath), {
      create: true,
      operation: "acquire-mutation-lock",
    });
    const owner = { pid: process.pid, token: randomUUID() };
    await this.#acquireMutationLock(lockPath, owner);
    try {
      return await operation();
    } finally {
      const observed = await this.#inspectMutationLock(lockPath);
      if (observed?.source === stableJson(owner)) {
        await this.#removeSafeFile(lockPath, {
          allowMultipleLinks: true,
          operation: "release-mutation-lock",
        });
      }
    }
  }

  async probe(sessionId) {
    await this.#ensureSafeDirectory(this.baseDirectory, {
      create: true,
      operation: "probe-store",
    });
    const stem = join(this.baseDirectory, `.probe-${sessionId}-${randomUUID()}`);
    const source = `${stem}.source`;
    const target = `${stem}.target`;
    const lock = `${stem}.lock`;
    const lockCandidate = `${stem}.lock-candidate`;
    let sourceHandle;
    let lockHandle;
    try {
      sourceHandle = await this.#openExclusive(source, "probe-write");
      await sourceHandle.writeFile("probe", "utf8");
      await sourceHandle.sync();
      await sourceHandle.close();
      sourceHandle = undefined;
      await rename(source, target);
      await this.#assertSafeFile(target, { allowMissing: false, operation: "probe-replace" });
      await this.#removeSafeFile(target, { operation: "probe-replace" });
      lockHandle = await this.#openExclusive(lockCandidate, "probe-lock");
      await lockHandle.writeFile("probe-lock", "utf8");
      await lockHandle.sync();
      await lockHandle.close();
      lockHandle = undefined;
      await link(lockCandidate, lock);
      await this.#assertSafeFile(lock, {
        allowMissing: false,
        allowMultipleLinks: true,
        operation: "probe-lock",
      });
      await this.#removeSafeFile(lockCandidate, {
        allowMultipleLinks: true,
        operation: "probe-lock",
      });
      await this.#removeSafeFile(lock, { operation: "probe-lock" });
      return { lock: "ok", replace: "ok", store: "ok" };
    } catch (error) {
      error.operation ??= error.code === "EEXIST" ? "lock" : "write-replace-remove";
      error.path ??= stem;
      error.remedy ??= "Conceder escritura y locks atómicos al directorio del store.";
      throw error;
    } finally {
      await sourceHandle?.close().catch(() => {});
      await lockHandle?.close().catch(() => {});
      for (const path of [source, target, lockCandidate, lock]) {
        try {
          await this.#removeSafeFile(path, {
            allowMultipleLinks: true,
            operation: "cleanup-store-probe",
          });
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
      if (!(await stat(command)).isFile()) return false;
      if (process.platform !== "win32") await access(command, fsConstants.X_OK);
      return true;
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
        if (!(await stat(candidate)).isFile()) continue;
        if (process.platform !== "win32") await access(candidate, fsConstants.X_OK);
        return true;
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
  constructor({ path, knownSecrets = [], prepare } = {}) {
    Object.defineProperties(this, {
      eventIds: { value: new Set() },
      knownSecrets: { value: [...knownSecrets] },
      path: { enumerable: true, value: path },
      prepare: { value: prepare },
    });
  }

  async append(event) {
    const safe = redactEvent(clone(event));
    const line = stableJson(safe);
    for (const secret of this.knownSecrets) {
      if (secret && line.includes(secret)) {
        throw new KernelError("telemetry_secret", "La telemetría contenía un secreto conocido.");
      }
    }
    if (this.prepare) await this.prepare();
    else await mkdir(dirname(this.path), { recursive: true });
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
    if (this.prepare) await this.prepare();
    let handle;
    try {
      handle = await open(
        this.path,
        fsConstants.O_WRONLY |
          fsConstants.O_APPEND |
          fsConstants.O_CREAT |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      if (this.prepare) await this.prepare(handle);
      const information = await handle.stat();
      if (!information.isFile() || information.nlink !== 1) {
        throw new KernelError("event_log_unsafe", "El event log no es un archivo contenido y exclusivo.", {
          operation: "append-event-log",
          path: this.path,
          remedy: "Retirar enlaces o hard links antes de reintentar.",
        });
      }
      await handle.writeFile(`${line}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (error.code === "ELOOP") {
        throw new KernelError("event_log_unsafe", "El event log no puede ser un enlace simbólico.", {
          operation: "append-event-log",
          path: this.path,
          remedy: "Retirar el enlace antes de reintentar.",
        });
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
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
