# Capa agéntica reusable

Plantilla declarativa para ejecutar desarrollo asistido por agentes en Codex y
Claude Code. La fuente de verdad vive en `.agents/`; los adapters solo conectan
las capacidades nativas de cada host.

## Adopción

Desde el paquete publicado:

```bash
npx @kroxidev/agentic-layer init .
```

Desde este repositorio:

```bash
node scripts/agentic-init.mjs --target <directorio>
```

Para actualizar una capa agéntica existente:

```bash
npx --yes github:KroxiDev/agentic-layer update .
```

La inicialización detecta hechos del proyecto, solicita únicamente los campos
contractuales que no puede inferir y escribe el inventario canónico. No instala
herramientas, no accede a remotos y no modifica Git. `--dry-run` muestra el plan
sin escribir; `--yes` acepta respuestas detectables; `--force` reemplaza solo
archivos canónicos divergentes; `update` actualiza una adopción existente con
transacción, poda segura y rollback.

## Activación y modos

La clasificación normativa está en
[`.agents/policies/orquestacion.md`](.agents/policies/orquestacion.md). Resumen:

| Ruta | Cuándo aplica | Ejecución |
| --- | --- | --- |
| Directa verificada | La política no detecta una categoría cerrada de orquestación y se cumplen sus límites. | Un agente, sin DevSession. |
| `light` | El usuario lo pide explícitamente. | Secuencia compacta, una unidad y evaluación combinada. |
| `full` | El usuario lo pide o la política detecta una categoría automática. | Fases aisladas, unidades, fan-in, validación integral y evaluación. |

Una petición explícita `sin orquestar` se respeta. La excepción bootstrap
permite reparar esta misma capa desde una especificación externa cerrada con un
solo agente, conservando seguridad y todas las validaciones.

## Modelo actual

`OrchestrationKernel` expone únicamente:

- `apply(command)`, única superficie de mutación;
- `inspect(sessionId)`, vista de solo lectura sin capacidades.

El contrato base está en `.agents/kernel/protocol.mjs`. `schemaVersion` vale `3`
y describe el formato actual; no existe negociación entre formatos. Los
schemas JSON tienen nombres estables y `.agents/protocol.json` declara las rutas
del inventario, markers, assets, directorios gestionados y el schema de los
únicos overrides admitidos: `contextBudgetBytes` y `telemetrySink`.
`protocol-manifest.mjs` valida y proyecta esa fuente única hacia conformidad,
inicializador, paquete y kernel. El sink nombrado se resuelve mediante el mapa
explícito `telemetrySinks`; `capabilityTtlMs` es una opción interna separada y
no un override público.

El estado persistente vive en `.agents/sessions/state/` como snapshot y event
log. El adapter de filesystem demuestra la contención física de cada ancestro y
rechaza redirecciones o enlaces ajenos en los archivos del ledger antes de
escribir; la reserva writer durable conserva dueño y checkpoint exactos. `.agents/sessions/`
queda fuera del paquete y del alcance de `update`, salvo su asset de ignore. Un
`start-session` crea la sesión. Cada `dispatch-attempt` declara
`baseRevision`, `threadId`, fase, rol, permiso, objetivo, reglas, tareas,
`findings` y `contextManifest`; el kernel valida lifecycle, unidad, lane,
ownership y compatibilidad del permiso antes de persistir. Explorador,
Planificador y Evaluador son `read-only`; Implementador y Documentador son
`writer`; Tester admite ambos según el contexto. El resultado es un
`WorkEnvelope` inmutable y autocontenido. Cada rol devuelve un `RoleReport` y
solo el orquestador lo presenta al kernel.

## Composición productiva

El paquete expone una sola factory productiva:

```js
import { createOrchestrationComposition } from "@kroxidev/agentic-layer/kernel/composition";

const host = createOrchestrationComposition({
  root: process.cwd(),
  configuration: { contextBudgetBytes: 128_000 },
});
```

`host` ofrece `apply`, `inspect` y `bootstrapCapability`; las únicas operaciones
del runtime siguen siendo `apply/inspect`. La factory compone
`FileSystemStateStore`, `SystemEnvironmentProbe`, reloj y telemetría JSONL
reales. `configuration` acepta solo los overrides de `protocol.json`;
`telemetrySink` se resuelve mediante `telemetrySinks`. `cacheDirectory`,
`temporaryDirectory`, `capabilities` y `capabilityTtlMs` son opciones internas
del host, no campos del contrato del proyecto.

La composición no crea agentes, no instala herramientas y no ejecuta ni
modifica Git. Para recuperar una DevSession tras reiniciar el proceso, se crea
otra composición con la misma `root`, se usa `inspect` para leer el snapshot y
se repite exactamente el comando `start-session` original con la nueva
`bootstrapCapability`; el kernel reemite la capacidad de la sesión sin repetir
la transición.

La vía normal de conducir el kernel desde un host es el CLI delgado
`.agents/scripts/kernel-cli.mjs`, un adapter de esa misma composición:

```bash
node .agents/scripts/kernel-cli.mjs help dispatch-attempt   # claves exactas del payload
node .agents/scripts/kernel-cli.mjs inspect <sessionId>     # vista JSON del snapshot
node .agents/scripts/kernel-cli.mjs brief <sessionId> <attemptId>  # prompt del despacho
node .agents/scripts/kernel-cli.mjs apply <tipo> --session <id> \
  --command-id <id> --expected-revision <n> --payload <archivo.json|->
```

Cada invocación es un proceso independiente: `apply` recupera autoridad
repitiendo el `start-session` persistido en `recovery.bootstrapCommand` del
snapshot y nunca imprime la capacidad. Un `KernelError` sale por stderr con su
`code` intacto (`stale_revision`, `idempotency_conflict`, `invalid_command`, …)
y exit code distinto de cero; `help <tipo>` deriva las claves admitidas del
propio kernel, sin listas paralelas.

## Contexto mínimo

La DevSession es el ledger de coordinación, no el prompt de un rol. El caller
declara un `contextManifest` atribuible y el kernel deriva `contextPaths` y
`sourceRevision`. El `WorkEnvelope` conserva además hash y tipo de contrato,
identidades de sesión e intento, versión, generación, revisión base, hilo,
fase, rol, permiso, criterios completos, ownership, estrategia de validación,
oleada, objetivo, reglas, tareas y findings. No contiene capacidades de
mutación ni el ledger. El rol consulta solo las rutas seleccionadas. Si falta
un dato indispensable, devuelve la incógnita exacta al orquestador para abrir
un intento nuevo con un sobre corregido.

El schema y el runtime de `RoleReport` comparten las mismas invariantes. Todo
finding accionable incluye `reproduction`; uno meramente informativo puede
omitirla. Los snapshots de formatos anteriores o incompletos fallan de forma
cerrada: no hay negociación ni migración implícita.

## Tareas anteriores explícitas

Cuando el usuario o un handoff entrega rutas concretas de una tarea anterior,
se leen como evidencia ordinaria. Se extraen objetivo, decisiones confirmadas,
restricciones, trabajo comprobable, validaciones vigentes y pendientes; luego
se contrastan con el repositorio y se inicia una sesión normal, sin importar
estado interno ni ampliar el protocolo.

Las rutas de limpieza se registran fuera del kernel. Solo tras éxito completo
se resuelven dentro del repositorio y se eliminan destinos exactos con ownership
inequívoco, sin globs; después se verifica su ausencia. Ante fallo, bloqueo,
ambigüedad o trabajo incompleto, el bundle se conserva.

## Workflows y roles

Los workflows canónicos son `feature`, `bugfix`, `refactor` y `architecture`.
Sus fases usan los roles Explorador, Planificador, Implementador, Tester,
Evaluador y Documentador. Los roles no hablan con el usuario, no se coordinan
entre sí y no llaman `OrchestrationKernel.apply`.

`architecture` registra una decisión aprobada y termina. Si hace falta
implementarla, la transfiere una sola vez a `feature` o `refactor`.

## Validación del repositorio

Validación sintáctica autoritativa:

```bash
npm run check
```

El comando deriva de `.agents/protocol.json` todos los módulos `.mjs` que
viajan en el paquete. La validación focalizada añade el caso relacionado:

```bash
node --test --test-name-pattern="<caso relacionado>"
```

Validación completa:

```bash
node --test
node scripts/agentic-init.mjs --dry-run --yes
npm pack --dry-run
```

La suite usa `node:test`, directorios temporales exclusivos y ninguna
dependencia externa. El empaquetado se inspecciona en seco y nunca contra el
registro.

## Estructura principal

- `AGENTS.md`: contrato configurable del proyecto.
- `.agents/policies/`: activación, seguridad y reglas comunes.
- `.agents/kernel/`: protocolo, estado y adapters de infraestructura.
- `.agents/kernel/composition.mjs`: única composición productiva del runtime.
- `.agents/kernel/protocol-manifest.mjs`: consumidor único del inventario y de
  la configuración declarados en `.agents/protocol.json`.
- `.agents/scripts/kernel-cli.mjs`: CLI delgado para conducir `apply`,
  `inspect`, `help` y `brief` del kernel desde procesos host.
- `.agents/schemas/`: contratos JSON actuales.
- `.agents/conformance/`: verificación de estructura y distribución.
- `.agents/roles/`, `.agents/workflows/`, `.agents/templates/`: proceso.
- `.codex/`, `.claude/` y `CLAUDE.md`: adapters delgados.
- `scripts/agentic-check.mjs`: check sintáctico derivado del inventario.
- `scripts/agentic-init.mjs` y `bin/agentic.mjs`: adopción y CLI.
- `tests/`: comportamiento público y distribución.

Consulta [CONTEXT.md](CONTEXT.md) para el glosario y
[docs/arquitectura.md](docs/arquitectura.md) para los flujos internos.
