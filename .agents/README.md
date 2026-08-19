# Núcleo de la capa agéntica

`.agents/` es el módulo reusable y la única fuente de verdad del proceso. Su
interface de configuración es el contrato delimitado de `AGENTS.md`: un
proyecto consumidor declara allí sus hechos, comandos y restricciones sin
editar roles, workflows, políticas, skills ni adapters.

Las sesiones usan el protocolo declarado en `protocol.json` y el módulo
profundo `kernel/`. Su instancia pública expone solo `apply` e `inspect`; los
roles reciben un `WorkEnvelope` sin capacidad de mutación y devuelven un
`RoleReport`. `schemaVersion` identifica el formato persistido actual sin
negociación ni rutas alternativas.

`kernel/composition.mjs` es el único composition root productivo. Construye el
store de filesystem, el preflight del sistema, el reloj y la telemetría durable,
y devuelve `apply`, `inspect` y la capacidad bootstrap opaca necesaria para
iniciar o recuperar autoridad. No crea agentes, instala herramientas ni toca
Git. Recrearlo sobre la misma raíz permite inspeccionar el snapshot y recuperar
la capacidad repitiendo exactamente `start-session`.

`scripts/kernel-cli.mjs` es la vía normal de conducir esa composición desde el
host: `apply`, `inspect` y `help <tipo>` con las claves exactas de payload
derivadas del kernel. Cada invocación es un proceso independiente que recupera
autoridad releyendo `recovery.bootstrapCommand` del snapshot; no añade métodos
al kernel, no imprime capacidades y deja los códigos de `KernelError` intactos
en stderr.

`protocol.json` es también la fuente autoritativa de rutas instaladas, assets,
markers, directorios gestionados y overrides del host. El consumidor compartido
`kernel/protocol-manifest.mjs` valida esa declaración y la proyecta hacia
conformidad, inicializador, inventario npm y kernel, sin listas paralelas.

`scripts/agentic-init.mjs` es la única superficie automatizada y la única
implementación de adopción y actualización. No forma parte del núcleo de
orquestación: detecta hechos y versiones, planifica el inventario canónico,
migra el bloque contractual de `AGENTS.md` y aplica cambios de forma
recuperable. Una elección interactiva explícita durante `update` también puede
mover una entrada desconocida fuera del contrato, a la sección efectiva
`## Reglas adicionales del proyecto`. `bin/agentic.mjs` es el ejecutable distribuible y solo
despacha `init` y `update` hacia esa implementación. Su comportamiento público
se verifica en `tests/*.test.mjs` con `node:test`, archivos cohesionados por
interfaz, directorios raíz temporales exclusivos y `CODEX_HOME` aislado.

`init` no interroga por hechos del contrato. Escribe lo que infiere —incluidos
los valores recomendados del perfil de ecosistema detectado— y deja
como `<pendiente: …>` lo que no puede inferir, listándolo al terminar en el
bloque `CONTRATO POR COMPLETAR`. Ese marcador es el que cobra la regla
`STRICT_PROJECT_CONTRACT_RULE` de `policies/orquestacion.md`: la primera sesión
del agente completa los huecos con la skill `agentic-grilling`, donde hay
contexto y conversación para decidirlos. `--purpose` y `--git-strategy` son un
atajo para declararlos en la propia adopción, nunca un requisito.

`update` sí pregunta cuando un contrato heredado contiene campos o bullets no
mapeables. Primero reúne todas las entradas y, solo con TTY y sin banderas no
interactivas ni `--dry-run`, permite mapear a un campo canónico libre, conservar
fuera del contrato, eliminar con confirmación adicional o cancelar. Las
decisiones viven en memoria hasta la transacción. En cualquier ejecución no
interactiva se listan todas las entradas y alternativas, se devuelve salida `2`
y no se escribe ningún archivo.

La capa se obtiene desde GitHub como paquete ejecutable y se adopta con
`npx --yes github:KroxiDev/agentic-layer init .`. La adopción es una
copia: el proyecto consumidor no declara dependencia, no consulta un upstream
y no recibe actualizaciones automáticas. Una copia existente se actualiza solo
por orden explícita con `agentic update`: el comando conserva DevSessions y
archivos ajenos fuera de directorios gestionados, repara el inventario incluso
con la misma versión y escribe
`.agents/VERSION` al final de la transacción.

Después de actualizar la capa, `update` puede habilitar explícitamente capacidad
técnica para 12 subagentes en un `config.toml` global o local. `--yes` no
autoriza esa operación: requiere `--codex-config global|local|none`. Los modos
conservan los presupuestos definidos por la política, independientes de ese
techo técnico. El editor conserva el TOML que no gestiona y deriva estructuras
ambiguas o strings multilínea a edición manual. Toda escritura autorizada usa
un temporal hermano y revalida ancestros no-follow justo antes de crearlo y
antes de la mutación final.

## Mapa

- `policies/`: orquestación, SDD/TDD y Regla de Oro para código y pruebas.
- `kernel/`: estado estructurado, idempotencia, ownership, aceptación, lanes,
  presupuesto, stores, reloj, preflight y telemetría.
- `kernel/composition.mjs`: factory productiva única para construir esos
  adapters sin ampliar las operaciones `apply/inspect`.
- `kernel/protocol-manifest.mjs`: validación y proyección del inventario y de
  los overrides declarados por `protocol.json`.
- `scripts/kernel-cli.mjs`: CLI delgado del kernel para procesos host —
  `apply`, `inspect` y `help` derivado del código.
- `schemas/`: contratos JSON de aceptación, reporte, evento y validación.
- `conformance/`: gate ejecutable de inventario, schemas, overrides e interface.
- `protocol.json`: inventario indivisible y schema de overrides admitidos.
- `roles/`: responsabilidades, límites y contratos de salida de seis roles.
- `workflows/`: orden de fases para feature, bugfix, refactor y architecture.
- `skills/`: routing portable de orquestación y procedimientos especializados
  invocados por los roles.
- `templates/`: formatos de la DevSession global y de los sobres de fase.
- `sessions/`: estado del propietario y vistas humanas por intento, ignorados por
  control de versiones; `gitignore.asset` es el `.gitignore` que el
  inicializador instala allí.
- `VERSION`: versión de la capa adoptada. La genera el inicializador en el
  destino, no viaja en el paquete y permite clasificar una instalación como
  sin versión, anterior, igual o posterior durante `update`. Los directorios
  declarados por `protocol.json` se gestionan por completo: al reemplazar, todo
  archivo ajeno al inventario canónico se elimina como residuo. `sessions/` y
  esta raíz no.
- `../bin/agentic.mjs`: ejecutable `agentic` con `init` y `update`.
- `../scripts/agentic-check.mjs`: deriva desde `protocol.json` los `.mjs`
  distribuidos y ejecuta `node --check` sobre todos.
- `../scripts/agentic-init.mjs`: inicializador y actualizador sin dependencias externas.
- `../tests/*.test.mjs`: pruebas por interfaz de adopción, `update`, Codex,
  kernel, CLI del kernel, composición productiva y distribución/contratos;
  `agentic-test-helpers.mjs`
  concentra fixtures sin estado global mutable.

## Mapa de propietarios

Cada decisión se modifica en su propietario y los demás módulos la consumen por
referencia:

| Tipo de decisión | Propietario canónico | Responsabilidad de los consumidores |
| --- | --- | --- |
| Activación, modos, presupuestos, unidades, validación, evaluación y cierre | [Política de orquestación](policies/orquestacion.md) | Enlazar la política sin copiar categorías, límites ni excepciones. |
| Estado durable e invariantes ejecutables | [`OrchestrationKernel`](kernel/orchestration-kernel.mjs) | El orquestador usa solo `apply/inspect`; los roles devuelven reportes sin mutar. |
| Composición de adapters productivos y bootstrap | [`createOrchestrationComposition`](kernel/composition.mjs) | El host aporta raíz, capacidades y configuración declarada; no reconstruye dependencias privadas. |
| Conducción del kernel desde procesos host | [`scripts/kernel-cli.mjs`](scripts/kernel-cli.mjs) | El orquestador usa el CLI en lugar de composición inline; los roles nunca lo invocan. |
| Orden e intención propios de cada flujo | [`workflows/`](workflows/) | Conservar marcadores `agentic-phase` y referenciar reglas comunes. |
| Entradas, proceso, salida y límites exclusivos de un rol | [`roles/`](roles/) | Mantener el contrato aislado y enlazar la política transversal. |
| Routing operativo | [`skills/orquestar/SKILL.md`](skills/orquestar/SKILL.md) | Cargar política, workflow y kernel actuales sin duplicar reglas. |
| Datos que persisten durante la tarea | [`templates/dev-session.md`](templates/dev-session.md) | Declarar campos sin explicar de nuevo sus reglas. |
| Descubrimiento de plataforma | [`.codex/`](../.codex/) y [`.claude/`](../.claude/) | Aplicar solo restricciones técnicas y apuntar al núcleo. |
| Inventario instalado, assets y overrides del host | [`protocol.json`](protocol.json) | `protocol-manifest.mjs`, conformidad, inicializador, paquete y kernel consumen la misma declaración. |

## Interface y adapters

El seam externo del proyecto es `AGENTS.md`: contiene hechos y restricciones
del proyecto adoptante. Separadamente, `protocol.json` define los overrides del
host. `contextBudgetBytes` se normaliza con su default y `telemetrySink` se
resuelve contra un mapa explícito de sinks; `capabilityTtlMs` permanece como
opción interna de seguridad, fuera de esa lista pública.

- Codex descubre los roles en `.codex/agents/*.toml`.
- Claude Code descubre los roles en `.claude/agents/*.md` y el wrapper público
  en `.claude/skills/orquestar/SKILL.md`.
- `CLAUDE.md` importa el `AGENTS.md` raíz.

Los adapters solo aplican restricciones técnicas y apuntan a archivos
canónicos. No contienen workflows ni políticas completas.

## Modelo de ejecución por unidades

El Planificador registra en la DevSession un DAG de una a tres unidades
verticales. Una unidad es estado durable de trabajo: `workUnitId`,
`criterionIds`, `dependsOn`, `ownedPaths`, `permission: "writer"`, una
`validationStrategy` admitida y una `wave` derivada por el kernel. Un intento
es una ejecución monotónica de fase y rol asociada a esa unidad, carril o eje;
declara `baseRevision`, `threadId`, fase, rol, permiso, objetivo, reglas,
tareas, findings y `contextManifest`, y conserva criterios completos,
ownership, estrategia, oleada, causa de retrabajo y evidencia. Reintentar no
crea otra unidad ni reactiva un intento terminal.

`OrchestrationKernel` concentra las invariantes mecánicas detrás de
`apply/inspect`:

1. valida DAG, ciclos, dependencias, ownership portable y compatibilidad entre
   rol, permiso, unidad, lane y lifecycle antes de despachar;
2. abre sólo unidades listas y hace cumplir los gates `implemented` →
   `validated` → `consolidated`; en compacto, el Evaluador combinado realiza
   los dos últimos de forma atómica;
3. reserva un único writer por identidad canónica del working tree, incluso
   entre DevSessions distintas;
4. valida los requisitos de herramientas, persistencia, aislamiento y
   telemetría antes de crear la sesión; la capacidad efectiva de subagentes la
   comprueba el host en el preflight canónico;
5. valida la integración, la estrategia y la generación codificadas en el
   estado; la elegibilidad humana de esas transiciones pertenece a la
   [política canónica](policies/orquestacion.md).

El constructor exige un `StateStore` explícito para no degradar producción a
memoria volátil. El host normal inyecta `FileSystemStateStore({ root })`, que
demuestra en cada acceso que todos los ancestros siguen siendo directorios
físicos dentro de `root`. Un symlink o junction intermedio, un enlace ajeno en
snapshot/event log o una ruta no verificable falla con `state_path_unsafe` antes
de escribir fuera de la raíz. El adapter
compone reemplazos atómicos de snapshots con un `JsonlEventSink` exclusivo; los
tests inyectan `MemoryStateStore`. El `EnvironmentProbe` predeterminado es el
adapter real.

El host normal obtiene esa composición mediante `createOrchestrationComposition`.
La factory pasa los overrides públicos al kernel, resuelve `telemetrySinks` y
mantiene `capabilityTtlMs`, cache, temporales y capacidades ambientales como
opciones internas. Su objeto público tiene solo dos funciones, `apply` e
`inspect`; `bootstrapCapability` es un dato opaco separado. Tras reiniciar, una
factory nueva sobre la misma raíz puede inspeccionar el ledger y recuperar la
capacidad repitiendo el comando inicial exacto.

`accept-role-report` conserva el reporte estructurado atribuible al intento y
el snapshot mantiene el estado de coordinación que devuelve `inspect`. El
schema JSON y el runtime comparten las mismas reglas: todo finding accionable
requiere `reproduction`; uno informativo puede omitirla. Una vista Markdown
puede representar ese estado, pero no se parsea para decidir gates. El
orquestador entrega al Evaluador y al Documentador solo los sobres pertinentes.

La telemetría usa un outbox en `telemetry.pendingEvents`: snapshot, resultado e
evento pendiente se comprometen juntos. Un retry exacto entrega el evento sin
repetir la transición, y el sink JSONL deduplica IDs ya durables tras un
reinicio.

Si un rol se interrumpe sin reporte, `record-attempt-failure` cierra el intento
con causa estructurada y libera su reserva. El retry crea otro intento y otro
sobre; el orquestador nunca sintetiza un `RoleReport` en nombre del rol.

El snapshot y el event log forman el ledger durable, no un input de despacho.
Antes de cada fase, `dispatch-attempt` crea el único `WorkEnvelope` normal con
hash y tipo de contrato, identidades, versión, generación, revisión base, hilo,
fase, rol, permiso, criterios completos, `ownedPaths`, estrategia de
validación, oleada, objetivo, reglas, tareas, findings, `contextManifest`,
`contextPaths` y `sourceRevision`. El caller aporta el manifiesto; el kernel
deriva las rutas y la revisión fuente. El sobre no contiene capacidad de
mutación ni el ledger. El rol consulta únicamente los archivos seleccionados.
Si el sobre resulta insuficiente, devuelve la incógnita exacta; el orquestador
cierra el intento y abre otro sin modificar retrospectivamente un sobre activo.

Antes de aceptar el plan, los sobres de Explorador, Planificador y la
reproducción compacta de `bugfix` referencian un `planningScopeHash` inmutable y
declaran `contractKind: planning-scope`. Después de `accept-plan`, todo sobre y
reporte referencia exclusivamente el hash del `AcceptanceContract` vigente.
`architecture` admite un contrato sin unidades cuando solo registra una
decisión: pasa de planificación a evaluación y documentación, sin inventar
implementación, Tester ni lane de código.

Las estrategias de validación, su vigencia, la secuencia compacta, el cierre
integrado, la evaluación y el gate de Documentador se definen una sola vez en la
[política canónica](policies/orquestacion.md). El kernel conserva solo el
estado y los gates ejecutables; Planificador, Tester, Evaluador y Documentador
aplican sus contratos de rol mediante esa referencia.

La adquisición del writer lock sincroniza un candidato completo y lo publica
por hard link. La reserva usa `schemaVersion: 3`, conserva el dueño exacto
`{session, attempt, workingTreeId}` y un checkpoint de `commandId`, fingerprint
y revisión esperada. Una transición terminal la libera sólo cuando el snapshot
demuestra ese mismo intento terminado. Si un intento sucesor ya la adquirió, el
reintento idempotente preserva sin cambios la reserva ajena. Los locks
transitorios global y de sesión registran `{pid, token}`: únicamente se recupera
un propietario demostrablemente terminado; un contenido ambiguo se conserva y
nunca se limpia por antigüedad.

El kernel acepta únicamente snapshots completos con `schemaVersion: 3`; un
snapshot anterior o uno que declare la versión actual sin sus campos
obligatorios falla con `state_protocol_mismatch`. Una sesión `light` persiste
`lightStrategy: "compact"`; `full` usa el lane integral de su generación. Un
estado ausente o inválido falla de forma cerrada y no se reinterpreta desde
Markdown.

## Invariantes

1. CodeGraph, Engram y subagentes son requisitos obligatorios con fallo cerrado.
2. Cada fase corre en un contexto aislado, recibe un `WorkEnvelope` mínimo y
   devuelve solo el reporte del rol.
3. `policies/orquestacion.md` decide la activación por riesgo; dentro de la capa,
   `full` es el modo predeterminado y `light` requiere petición explícita. La
   estrategia compacta reduce contextos, no seguridad, aislamiento ni revisión
   independiente.
4. La DevSession es efímera y no se reemplaza con memoria durable.
5. Engram conserva únicamente conocimiento validado, reutilizable y
   accionable.
6. Ningún proyecto necesita personalizar archivos distintos de `AGENTS.md`.
7. El inicializador nunca sobrescribe una colisión por defecto, instala
   herramientas, accede a remotos ni modifica Git. `--force` se limita a los
   archivos canónicos divergentes y nunca reescribe el seam `AGENTS.md`.
8. La adopción se completa con un solo comando: el inicializador no pregunta
   hechos del contrato ni falla por un dato ausente; lo marca como pendiente y
   deja que la regla estricta del contrato lo cobre antes de orquestar.
9. CodeGraph solo se inicializa o sincroniza mediante confirmación explícita;
   las comprobaciones predeterminadas son de solo lectura.
10. La distribución transporta únicamente el inventario canónico: nunca
    índices, memorias, sesiones reales, configuraciones personales ni tests.
11. La adopción no crea dependencia ni sincronización con la plantilla.
12. `update` aplica primero la capa como una transacción recuperable y trata la
    configuración de Codex como una operación opcional posterior.
13. Los valores contractuales explícitos, incluidos autolinks y texto con
    ángulos, no se confunden con placeholders pendientes.
14. Los límites, categorías y excepciones transversales tienen un único
    propietario humano: `policies/orquestacion.md`.
15. El kernel hace cumplir ownership, gates, evidencia y generaciones sin
    convertir su implementación en otra fuente de prosa normativa.
16. Roles, workflows, skills, templates y adapters consumen a sus propietarios
    mediante referencias y marcadores estables.
17. El contrato administrado solo admite campos canónicos. Una entrada
    desconocida puede salir del bloque únicamente por elección interactiva
    explícita y permanece efectiva bajo `## Reglas adicionales del proyecto`;
    cancelar o ejecutar sin interacción conserva el destino byte a byte.
18. Solo una capacidad opaca del orquestador puede mutar el estado; nunca aparece en
    `contextPaths`, prompts, sobres, reportes, snapshots ni eventos.
19. La aceptación cambia únicamente mediante un amendment aprobado y un hash
    nuevo; un finding técnico nuevo no amplía alcance por sí mismo.
20. En `full`, el lane `full:<generation>` queda verde antes de evaluar y una
    misma evidencia por fingerprint se consume una sola vez.
