import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import {
  PACKAGE_FILES,
  TEMPLATE_FILES,
  isMissingContractValue,
} from "../scripts/agentic-init.mjs";

import {
  BIN,
  CLI,
  ROOT,
  SIN_HERRAMIENTAS,
  countPendingFields,
  createRepository,
  linksToPolicy,
  markdownLinks,
  markdownSection,
  roleOutputLabels,
  runExecutable,
  runExecutableWithEnvironment,
  runInitializer,
  runInitializerWithoutFlags,
  runInteractiveExecutableWithEnvironment,
  runInteractiveUpdate,
  snapshotDirectory,
} from "./agentic-test-helpers.mjs";

test("Codex efectivo igual o superior a 12 no se pregunta, modifica ni reduce", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-listo", description: "Config suficiente." }),
    ".codex/config.toml": "[agents]\nmax_concurrent_threads_per_session = 12\n",
  });
  const codexHome = await createRepository({
    "config.toml": "[agents]\nmax_concurrent_threads_per_session = 3\n",
  });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const beforeLocal = await readFile(join(repository, ".codex", "config.toml"), "utf8");
  const beforeGlobal = await readFile(join(codexHome, "config.toml"), "utf8");

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "global",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /límite efectivo.*12.*no se modifica/i);
  assert.equal(await readFile(join(repository, ".codex", "config.toml"), "utf8"), beforeLocal);
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), beforeGlobal);
});

test("Codex considera desconocido el efectivo si la capa local o global es ambigua", async () => {
  const cases = [
    {
      name: "local-ambigua",
      local: "[agents]\nmax_threads = 3\n[agents]\nmax_threads = 4\n",
      global: "[agents]\nmax_concurrent_threads_per_session = 15\n",
    },
    {
      name: "global-ambigua",
      local: "[agents]\nmax_concurrent_threads_per_session = 12\n",
      global: "[agents]\nmax_threads = 3\n[agents]\nmax_threads = 4\n",
    },
  ];

  for (const fixture of cases) {
    const repository = await createRepository({
      "package.json": JSON.stringify({ name: fixture.name, description: "Prueba ambigüedad." }),
      ".codex/config.toml": fixture.local,
    });
    const codexHome = await createRepository({ "config.toml": fixture.global });
    assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

    const result = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--yes",
      "--codex-config",
      "local",
    );

    assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
    assert.match(result.stdout, /valor efectivo.*desconocido/i);
    assert.match(result.stdout, /edición manual/i);
    assert.doesNotMatch(result.stdout, /ya tiene un límite efectivo/i);
    assert.equal(await readFile(join(repository, ".codex", "config.toml"), "utf8"), fixture.local);
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), fixture.global);
  }
});

test("Codex global conserva BOM, EOL, comentarios y claves al actualizar solo la clave objetivo", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-global", description: "Edita global." }),
  });
  const original =
    "\uFEFF# configuración\r\nmodel = \"gpt\"\r\n\r\n[agents]\r\nmax_concurrent_threads_per_session = 4 # anterior\r\nfoo = true\r\n\r\n[otro]\r\nvalor = 1\r\n";
  const codexHome = await createRepository({ "config.toml": original });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "global",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.equal(
    await readFile(join(codexHome, "config.toml"), "utf8"),
    original.replace("= 4 # anterior", "= 12 # anterior"),
  );
  assert.equal(existsSync(join(repository, ".codex", "config.toml")), false);
});

test("Codex local crea o migra max_threads solo con autorización explícita", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-local", description: "Edita local." }),
  });
  const codexHome = await createRepository({
    "config.toml": "[agents]\nmax_threads = 5 # anterior\nmodel_reasoning_effort = \"high\"\n",
  });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

  const pending = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
  );
  assert.equal(pending.status, SIN_HERRAMIENTAS, pending.stderr || pending.stdout);
  assert.match(pending.stdout, /configuración de Codex.*pendiente/i);
  assert.equal(existsSync(join(repository, ".codex", "config.toml")), false);
  assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /max_threads = 5/);

  const local = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "local",
  );
  assert.equal(local.status, SIN_HERRAMIENTAS, local.stderr || local.stdout);
  assert.equal(
    await readFile(join(repository, ".codex", "config.toml"), "utf8"),
    "[agents]\nmax_concurrent_threads_per_session = 12\n",
  );

  await rm(join(repository, ".codex", "config.toml"));
  const global = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "global",
  );
  assert.equal(global.status, SIN_HERRAMIENTAS, global.stderr || global.stdout);
  assert.equal(
    await readFile(join(codexHome, "config.toml"), "utf8"),
    "[agents]\nmax_concurrent_threads_per_session = 12 # anterior\nmodel_reasoning_effort = \"high\"\n",
  );
});

test("Codex ambiguo queda manual y la precedencia local inferior no se oculta", async () => {
  const ambiguousRepository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-ambiguo", description: "TOML ambiguo." }),
    ".codex/config.toml": "[agents]\nmax_threads = 3\n[agents]\nmax_threads = 4\n",
  });
  const codexHome = await createRepository({
    "config.toml": "[agents]\nmax_concurrent_threads_per_session = 15\n",
  });
  assert.equal(runInitializer(ambiguousRepository).status, SIN_HERRAMIENTAS);
  const before = await readFile(join(ambiguousRepository, ".codex", "config.toml"), "utf8");

  const ambiguous = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    ambiguousRepository,
    "--yes",
    "--codex-config",
    "local",
  );
  assert.equal(ambiguous.status, SIN_HERRAMIENTAS, ambiguous.stderr || ambiguous.stdout);
  assert.match(ambiguous.stdout, /TOML ambiguo|edición manual/i);
  assert.equal(await readFile(join(ambiguousRepository, ".codex", "config.toml"), "utf8"), before);

  const precedenceRepository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-precedencia", description: "Precedencia local." }),
    ".codex/config.toml": "[agents]\nmax_concurrent_threads_per_session = 2\n",
  });
  assert.equal(runInitializer(precedenceRepository).status, SIN_HERRAMIENTAS);
  const precedence = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    precedenceRepository,
    "--yes",
    "--codex-config",
    "global",
  );
  assert.equal(precedence.status, SIN_HERRAMIENTAS, precedence.stderr || precedence.stdout);
  assert.match(precedence.stdout, /local.*precedencia.*seguirá usando.*2/i);
  assert.match(
    await readFile(join(precedenceRepository, ".codex", "config.toml"), "utf8"),
    /max_concurrent_threads_per_session = 2/,
  );
  assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /= 15/);
});

test("Codex deriva a edición manual toda definición agents o clave objetivo no soportada", async () => {
  const variants = [
    "agents = { max_concurrent_threads_per_session = 3 }\n",
    "[\"agents\"]\nmax_concurrent_threads_per_session = 3\n",
    "[[agents]]\nmax_concurrent_threads_per_session = 3\n",
    "[agents.worker]\nmax_concurrent_threads_per_session = 3\n",
    "agents.max_concurrent_threads_per_session = 3\n",
    "[agents]\n\"max_concurrent_threads_per_session\" = 3\n",
    "[agents]\n'max_threads' = 3\n",
  ];

  for (const source of variants) {
    const repository = await createRepository({
      "package.json": JSON.stringify({ name: "toml-conservador", description: "Prueba TOML." }),
      ".codex/config.toml": source,
    });
    const codexHome = await createRepository();
    assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

    const result = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--yes",
      "--codex-config",
      "local",
    );

    assert.equal(result.status, SIN_HERRAMIENTAS, `${source}\n${result.stderr || result.stdout}`);
    assert.match(result.stdout, /TOML ambigu|edición manual/i);
    assert.equal(await readFile(join(repository, ".codex", "config.toml"), "utf8"), source);
  }
});

test("Codex conserva byte a byte strings TOML multilínea con tablas y claves aparentes", async () => {
  const variants = [
    'mensaje = """\n[agents]\nmax_concurrent_threads_per_session = 2\n"""\n',
    "mensaje = '''\n[agents]\nmax_threads = 2\n'''\n",
  ];

  for (const source of variants) {
    const repository = await createRepository({
      "package.json": JSON.stringify({ name: "toml-multilinea", description: "Prueba léxica." }),
      ".codex/config.toml": source,
    });
    const codexHome = await createRepository();
    assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

    const result = runExecutableWithEnvironment(
      { CODEX_HOME: codexHome },
      "update",
      repository,
      "--yes",
      "--codex-config",
      "local",
    );

    assert.equal(result.status, SIN_HERRAMIENTAS, `${source}\n${result.stderr || result.stdout}`);
    assert.match(result.stdout, /TOML.*multilínea|edición manual/i);
    assert.equal(await readFile(join(repository, ".codex", "config.toml"), "utf8"), source);
  }
});

test("Codex local revalida ancestros no-follow justo antes de crear el temporal", async () => {
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-carrera-local", description: "Prueba no-follow." }),
  });
  const codexHome = await createRepository();
  const external = await createRepository({ "sentinel.txt": "exterior intacto\n" });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const externalBefore = await snapshotDirectory(external);

  const result = runExecutableWithEnvironment(
    {
      CODEX_HOME: codexHome,
      AGENTIC_INIT_TEST_CODEX_RACE_STAGE: "before-temporary",
      AGENTIC_INIT_TEST_CODEX_RACE_TARGET: external,
    },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "local",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /enlace simbólico no seguro|ancestro no seguro/i);
  assert.match(result.stdout, /Editar manualmente .*config\.toml/i);
  assert.deepEqual(await snapshotDirectory(external), externalBefore);
});

test("Codex global revalida ancestros no-follow justo antes de la mutación final", async () => {
  const container = await createRepository();
  const codexHome = join(container, "codex-home");
  const external = join(container, "external");
  await mkdir(codexHome);
  await mkdir(external);
  await writeFile(join(external, "sentinel.txt"), "exterior intacto\n", "utf8");
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "codex-carrera-global", description: "Prueba no-follow." }),
  });
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);
  const externalBefore = await snapshotDirectory(external);

  const result = runExecutableWithEnvironment(
    {
      CODEX_HOME: codexHome,
      AGENTIC_INIT_TEST_CODEX_RACE_STAGE: "before-mutation",
      AGENTIC_INIT_TEST_CODEX_RACE_TARGET: external,
    },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "global",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.match(result.stdout, /enlace simbólico no seguro|ancestro no seguro/i);
  assert.match(result.stdout, /Editar manualmente .*config\.toml/i);
  assert.deepEqual(await snapshotDirectory(external), externalBefore);
});

test("Codex delimita agents ante tablas-array y conserva sus claves objetivo byte a byte", async () => {
  const source =
    "[agents]\r\nfoo = true\r\n\r\n[[workers]]\r\nmax_concurrent_threads_per_session = 3 # worker\r\nmax_threads = 4 # worker anterior\r\n";
  const repository = await createRepository({
    "package.json": JSON.stringify({ name: "toml-array", description: "Prueba límite TOML." }),
    ".codex/config.toml": source,
  });
  const codexHome = await createRepository();
  assert.equal(runInitializer(repository).status, SIN_HERRAMIENTAS);

  const result = runExecutableWithEnvironment(
    { CODEX_HOME: codexHome },
    "update",
    repository,
    "--yes",
    "--codex-config",
    "local",
  );

  assert.equal(result.status, SIN_HERRAMIENTAS, result.stderr || result.stdout);
  assert.equal(
    await readFile(join(repository, ".codex", "config.toml"), "utf8"),
    source.replace("foo = true\r\n", "max_concurrent_threads_per_session = 12\r\nfoo = true\r\n"),
  );
});
