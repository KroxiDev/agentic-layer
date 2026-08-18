import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { protocolPackageFiles } from "../.agents/kernel/protocol-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function copyDistributedPackage(destination) {
  for (const relativePath of protocolPackageFiles()) {
    const target = join(destination, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(ROOT, ...relativePath.split("/")), target);
  }
}

test("la composición distribuida inicia, persiste, inspecciona y recupera una DevSession", async (t) => {
  const packageRoot = await mkdtemp(join(tmpdir(), "agentic-package-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "agentic-runtime-"));
  t.after(async () => {
    await Promise.all([
      rm(packageRoot, { force: true, recursive: true }),
      rm(runtimeRoot, { force: true, recursive: true }),
    ]);
  });
  await copyDistributedPackage(packageRoot);

  const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(
    packageManifest.exports["./kernel/composition"],
    "./.agents/kernel/composition.mjs",
  );
  const { createOrchestrationComposition } = await import(
    pathToFileURL(join(packageRoot, ".agents", "kernel", "composition.mjs")).href
  );

  const options = {
    cacheDirectory: join(runtimeRoot, ".cache"),
    configuration: { contextBudgetBytes: 64_000 },
    root: runtimeRoot,
    temporaryDirectory: join(runtimeRoot, ".tmp"),
  };
  const firstHost = createOrchestrationComposition(options);
  assert.deepEqual(Object.keys(firstHost).sort(), ["apply", "bootstrapCapability", "inspect"]);
  assert.deepEqual(
    Object.entries(firstHost)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort(),
    ["apply", "inspect"],
  );

  const startCommand = {
    schemaVersion: 3,
    commandId: "start-distributed-session",
    sessionId: "distributed-session",
    expectedRevision: 0,
    actorCapability: firstHost.bootstrapCapability,
    type: "start-session",
    payload: { mode: "full", workflow: "feature" },
  };
  const started = await firstHost.apply(startCommand);
  assert.equal(started.decision, "started");
  assert.equal(started.revision, 1);
  assert.equal((await firstHost.inspect(startCommand.sessionId)).contextBudgetBytes, 64_000);

  const secondHost = createOrchestrationComposition(options);
  assert.equal((await secondHost.inspect(startCommand.sessionId)).revision, 1);
  const recovered = await secondHost.apply({
    ...startCommand,
    actorCapability: secondHost.bootstrapCapability,
  });
  assert.equal(recovered.revision, 1);
  assert.ok(recovered.actorCapability);

  const eventLog = await readFile(
    join(runtimeRoot, ".agents", "sessions", "state", "events.jsonl"),
    "utf8",
  );
  assert.match(eventLog, /"commandId":"start-distributed-session"/);
  assert.doesNotMatch(eventLog, /actorCapability|bootstrapCapability/);
});

test(
  "el preflight POSIX exige permiso de ejecución para resolver un comando",
  { skip: process.platform === "win32" },
  async (t) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "agentic-command-"));
    t.after(() => rm(runtimeRoot, { force: true, recursive: true }));
    const commandPath = join(runtimeRoot, "agentic-test-command");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

    const host = (
      await import("../.agents/kernel/composition.mjs")
    ).createOrchestrationComposition({
      cacheDirectory: join(runtimeRoot, ".cache"),
      root: runtimeRoot,
      temporaryDirectory: join(runtimeRoot, ".tmp"),
    });
    const startCommand = {
      schemaVersion: 3,
      commandId: "start-command-probe",
      sessionId: "command-probe",
      expectedRevision: 0,
      actorCapability: host.bootstrapCapability,
      type: "start-session",
      payload: {
        mode: "full",
        requirements: { commands: [commandPath] },
        workflow: "feature",
      },
    };

    await assert.rejects(host.apply(startCommand), (error) => {
      assert.equal(error.code, "environment_failed");
      assert.equal(error.details.check, "command");
      assert.equal(error.details.path, commandPath);
      return true;
    });
    await assert.rejects(host.inspect(startCommand.sessionId), { code: "session_not_found" });

    await chmod(commandPath, 0o755);
    assert.equal((await host.apply(startCommand)).decision, "started");
  },
);

test(
  "el preflight Windows resuelve comandos mediante PATHEXT",
  { skip: process.platform !== "win32" },
  async (t) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "agentic-pathext-"));
    const commandDirectory = join(runtimeRoot, "bin");
    await mkdir(commandDirectory);
    await writeFile(join(commandDirectory, "agentic-test-command.CMD"), "@exit /b 0\r\n");
    const originalPath = process.env.PATH;
    const originalPathExt = process.env.PATHEXT;
    process.env.PATH = commandDirectory;
    process.env.PATHEXT = ".CMD";
    t.after(async () => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathExt;
      await rm(runtimeRoot, { force: true, recursive: true });
    });

    const host = (
      await import("../.agents/kernel/composition.mjs")
    ).createOrchestrationComposition({
      cacheDirectory: join(runtimeRoot, ".cache"),
      root: runtimeRoot,
      temporaryDirectory: join(runtimeRoot, ".tmp"),
    });
    const started = await host.apply({
      schemaVersion: 3,
      commandId: "start-pathext-probe",
      sessionId: "pathext-probe",
      expectedRevision: 0,
      actorCapability: host.bootstrapCapability,
      type: "start-session",
      payload: {
        mode: "full",
        requirements: { commands: ["agentic-test-command"] },
        workflow: "feature",
      },
    });

    assert.equal(started.decision, "started");
  },
);
