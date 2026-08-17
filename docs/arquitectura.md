# Arquitectura

Detalle interno de la plantilla. La vista resumida está en el
[README](../README.md); el vocabulario, en [CONTEXT.md](../CONTEXT.md). Esta
documentación no se distribuye con la capa.

## Las dos mitades

El repositorio hace dos cosas independientes, y conviene no confundirlas:

1. **El proceso** (`.agents/` y sus adapters): lo que gobierna cómo un agente
   desarrolla en un proyecto. Las políticas y roles son contratos; el kernel V2
   ejecuta sus invariantes estructuradas.
2. **La adopción y actualización** (`bin/` y `scripts/`): lo que copia o
   actualiza ese proceso y mantiene su contrato. Es código; se ejecuta solo por
   orden explícita del propietario y no sincroniza el destino automáticamente.

```mermaid
flowchart TB
    subgraph plantilla["Plantilla (esta fuente canónica)"]
        nucleo[".agents/<br/>núcleo del proceso"]
        adapters[".codex/ · .claude/ · CLAUDE.md<br/>adapters delgados"]
        init["scripts/agentic-init.mjs<br/>inicializador y actualizador"]
        bin["bin/agentic.mjs<br/>ejecutable agentic"]
        bin --> init
    end

    subgraph destino["Proyecto adoptante"]
        copia[".agents/ · .codex/ · .claude/<br/>copia del inventario"]
        contrato["AGENTS.md<br/>contrato de proyecto"]
        version[".agents/VERSION<br/>versión adoptada"]
    end

    nucleo -.->|inventario canónico| init
    adapters -.->|inventario canónico| init
    init ==>|copia o actualiza| copia
    init ==>|genera o migra solo el bloque delimitado| contrato
    init ==>|escribe al final| version

    contrato --> orquesta["Orquestación:<br/>roles aislados sobre el contrato"]
    copia --> orquesta
```

La flecha que no existe es la importante: el destino no vuelve hacia la
plantilla. No hay dependencia declarada, remoto upstream ni sincronización
automática — ver [ADR 0001](adr/0001-adopcion-por-copia.md).

## Estructura completa

```text
.
├── README.md                    # adopción y operación (se distribuye)
├── CONTEXT.md                   # glosario del dominio (no se distribuye)
├── AGENTS.md                    # reglas globales + contrato de proyecto
├── CLAUDE.md                    # import fijo de AGENTS.md
├── LICENSE
├── package.json                 # manifiesto e inventario canónico
├── .gitignore
├── bin/
│   └── agentic.mjs              # ejecutable; despacha `init` y `update`
├── scripts/
│   └── agentic-init.mjs         # única implementación de init/update
├── tests/
│   ├── agentic-init.test.mjs    # inicialización y adopción
│   ├── agentic-update.test.mjs  # update y rollback
│   ├── codex-config.test.mjs    # configuración Codex
│   ├── session-controller.test.mjs
│   ├── distribution-contracts.test.mjs
│   └── agentic-test-helpers.mjs # fixtures aislados compartidos
├── docs/                        # documentación interna (no se distribuye)
│   ├── arquitectura.md
│   └── adr/
├── .agents/                     # NÚCLEO — fuente de verdad del proceso
│   ├── README.md                # documentación del módulo interno
│   ├── VERSION                  # generado en la adopción, no distribuido
│   ├── policies/
│   │   ├── orquestacion.md      # precedencia, preflight, modos, delegación
│   │   ├── regla-de-oro.md       # regla transversal para código y pruebas
│   │   └── sdd-tdd.md            # SDD proporcional y vocabulario de diseño
│   ├── protocol.json              # versión indivisible y overrides admitidos
│   ├── kernel/
│   │   ├── orchestration-kernel.mjs # interface apply/inspect
│   │   ├── adapters.mjs           # stores, clocks, probes y sinks
│   │   ├── protocol-v2.mjs        # hashing y contratos base
│   │   └── v1-compatibility.mjs   # lectura/migración explícita v1
│   ├── schemas/                   # AcceptanceContract, RoleReport, eventos y evidencia
│   ├── conformance/               # gate de protocolo y drift
│   ├── roles/                   # seis roles: entradas, proceso, salida, límites
│   │   ├── explorador.md
│   │   ├── planificador.md
│   │   ├── implementador.md
│   │   ├── tester.md
│   │   ├── evaluador.md
│   │   └── documentador.md
│   ├── scripts/
│   │   └── session-controller.mjs # runtime de compatibilidad para sesiones v1
│   ├── workflows/
│   │   ├── feature.md
│   │   ├── bugfix.md
│   │   ├── refactor.md
│   │   └── architecture.md
│   ├── skills/                  # procedimientos portables
│   │   ├── orquestar/SKILL.md
│   │   ├── agentic-grilling/SKILL.md
│   │   ├── agentic-tdd/SKILL.md
│   │   └── agentic-diagnostico-bugs/
│   │       ├── SKILL.md
│   │       └── references/      # contrato HITL + esqueletos sh y ps1
│   ├── templates/
│   │   ├── dev-session.md       # estado global de una tarea
│   │   └── subdev-session.md    # sobre efímero por fase e intento
│   └── sessions/
│       └── gitignore.asset      # se instala como .gitignore
├── .codex/agents/               # ADAPTER — seis TOML
└── .claude/
    ├── gitignore.asset          # se instala como .gitignore
    ├── agents/                  # ADAPTER — seis Markdown
    └── skills/orquestar/SKILL.md
```

## Mapa de módulos

| Parte | Responsabilidad | Profundidad |
| --- | --- | --- |
| `.agents/policies/` | Orquestación, SDD/TDD y Regla de Oro para código y pruebas | Profundo: gobierna todo el proceso |
| `.agents/roles/` | Seis contratos de salida con límites explícitos | Profundo: cada rol oculta su método |
| `.agents/kernel/orchestration-kernel.mjs` | Estado V2, CAS, idempotencia, ownership, aceptación, lanes, presupuesto, persistencia y telemetría | Profundo: solo `apply/inspect` |
| `.agents/kernel/adapters.mjs` | Filesystem/memoria, reloj, preflight y event sinks | Profundo: seams de producción y tests |
| `.agents/scripts/session-controller.mjs` | Terminar o recuperar sesiones v1 durante su ventana de soporte | Compatibilidad: no inicia V2 |
| `.agents/schemas/` y `.agents/conformance/` | Versionar contratos y rechazar mezclas o drift | Gate distribuible |
| `.agents/workflows/` | Orden de fases por intención | Delgado: sólo secuencia |
| `.agents/skills/` | Routing de orquestación y disciplinas invocables (grilling, TDD, diagnóstico) | `orquestar` delgada; disciplinas especializadas profundas |
| `.agents/templates/` | Formato de la DevSession global y de los sobres efímeros | Delgado: estructura |
| `AGENTS.md` | Seam de configuración: hechos y restricciones del proyecto | Interface mínima de toda la capa |
| `.codex/agents/*.toml` | Nombre, descripción, sandbox y puntero al rol canónico | Delgado por diseño |
| `.claude/agents/*.md` | Frontmatter de herramientas y permisos, y puntero al rol | Delgado por diseño |
| `.claude/skills/orquestar/` | Activación nativa que remite a la skill canónica | Delgado por diseño |
| `CLAUDE.md` | Importa `AGENTS.md` y fija el routing v2/v1 sin duplicar política | Delgado por diseño |
| `bin/agentic.mjs` | Despacho de `init`, `update` y ayuda | Delgado: no reimplementa nada |
| `scripts/agentic-init.mjs` | Detección, plan, copia/actualización recuperable, contrato, configuración opcional de Codex y comprobaciones | Profundo: toda la adopción y actualización |
| `tests/*.test.mjs` | Comportamiento público por interfaz, en procesos paralelos con directorios raíz temporales exclusivos | Especificación ejecutable |
| `tests/agentic-test-helpers.mjs` | Fixtures de filesystem, CLI y session-controller sin estado global mutable | Helper profundo de tests |

Este mapa expresa ownership, no una obligación de repetir reglas. El inventario
operativo de propietarios y la responsabilidad exacta de cada consumidor se
mantienen en el [README interno](../.agents/README.md#mapa-de-propietarios): la
política posee decisiones humanas transversales, el controlador sus invariantes
ejecutables, workflows el orden, roles sus contratos, la skill el routing y las
plantillas solo los datos persistidos.

La regla que mantiene la interface pequeña: un proyecto normal edita
`AGENTS.md` y nada más — ver [ADR 0002](adr/0002-agents-md-como-unico-seam.md).
Los adapters aplican restricciones técnicas y apuntan a rutas canónicas; nunca
duplican políticas.

## Flujo de adopción

`agentic init` es transaccional: calcula el plan completo antes de escribir y
cualquier condición bloqueante lo detiene con el disco intacto.

```mermaid
flowchart TD
    start["agentic init [destino]"] --> safe{"destino seguro?"}
    safe -->|no| e1["salida 1"]
    safe -->|sí| detect["detectar propósito, ecosistema,<br/>entrypoints, comandos, tests, docs"]
    detect --> layer["detectar capa instalada<br/>por marcadores + .agents/VERSION"]
    layer --> plan["PLAN: copias, divergencias,<br/>colisiones y residuos"]
    plan --> col{"colisión?"}
    col -->|sí| e2["salida 2 · cero escrituras"]
    col -->|no| div{"divergencia sobre<br/>capa instalada?"}
    div -->|"sí, con terminal"| ask["reemplazar o cancelar"]
    div -->|"sí, sin terminal"| e2b["salida 2 · pide --force"]
    div -->|no| integrity
    ask -->|cancelar| e3["salida 3"]
    ask -->|reemplazar| integrity
    integrity["integridad estructural<br/>+ adapters"] --> write["copiar inventario ·<br/>generar contrato ·<br/>borrar residuos · escribir VERSION"]
    write --> tools{"CodeGraph y Engram<br/>disponibles?"}
    tools -->|no| e4["salida 4 · REQUISITOS FALTANTES<br/>(los archivos ya se copiaron)"]
    tools -->|sí| ok["salida 0"]
```

Puntos que no son obvios leyendo el código por partes:

- **La detección no pregunta nunca.** Lo que no puede inferir queda como campo
  pendiente y se lista al terminar — ver
  [ADR 0003](adr/0003-inicializador-sin-conversacion.md).
- **Lo ya declarado gana.** Los valores explícitos que ya estén en el contrato
  sobreviven a cualquier reejecución; `--force` no reescribe `AGENTS.md` fuera
  del bloque delimitado, ni dentro de él.
- **Una copia de la plantilla no hereda su propósito.** Si el destino trae el
  `AGENTS.md` y el `README.md` de la plantilla sin tocar, el propósito detectado
  se descarta y queda pendiente: es el del proceso, no el del proyecto.
- **Revalidación justo antes de escribir.** Si un archivo aparece o cambia entre
  el plan y la escritura, se aborta el resto.
- **Salida 4 no revierte nada.** La capa queda instalada; lo que falta son las
  herramientas que el preflight de orquestación exigirá después — ver
  [ADR 0004](adr/0004-requisitos-obligatorios-con-fallo-cerrado.md).

## Flujo de actualización

`agentic update` reutiliza el mismo motor y añade una transacción recuperable.
La configuración opcional de Codex ocurre después del éxito de la capa y nunca
la revierte.

```mermaid
flowchart TD
    start["agentic update [destino]"] --> detect["detectar marcadores y VERSION"]
    detect --> exists{"¿existe la capa?"}
    exists -->|no| init["salida 2 · usar agentic init"]
    exists -->|sí| version{"legacy, anterior,<br/>igual o posterior"}
    version -->|posterior sin permiso| block["salida 2 · cero escrituras"]
    version --> unknown{"¿entradas contractuales<br/>no mapeables?"}
    unknown -->|"sí, sin terminal o dry-run"| unmapped["salida 2 · listar todas<br/>· cero escrituras"]
    unknown -->|"sí, con terminal"| decide["por entrada: mapear · conservar<br/>· eliminar · cancelar"]
    decide -->|cancelar| cancel
    decide -->|resueltas en memoria| plan
    unknown -->|no| plan["plan completo:<br/>copias · reemplazos · residuos · contrato"]
    plan --> confirm{"confirmación general"}
    confirm -->|cancelar| cancel["salida 3"]
    confirm -->|aplicar| revalidate["revalidar contenido, identidad<br/>y ancestros no-follow"]
    revalidate --> tx["respaldar · aplicar · VERSION al final"]
    tx -->|falla| rollback["restaurar y verificar;<br/>conservar respaldos si queda incompleto"]
    tx -->|éxito| codex{"configuración Codex<br/>autorizada y segura"}
    codex -->|no o ambigua| pending["conservar · edición manual pendiente"]
    codex -->|sí| atomic["temporal hermano · revalidar ancestros · mutar"]
    atomic --> done["capa actualizada"]
    pending --> done
```

La migración contractual reconoce campos históricos por alias y los contratos
nuevos por IDs estables. Solo `<pendiente: …>`, el placeholder histórico
admitido y los estados textuales `TODO`, `pendiente`, `por definir` o `TBD`
cuentan como valores ausentes; autolinks Markdown y otros hechos legítimos con
ángulos se preservan.

Los campos y bullets que no puedan mapearse se reúnen por completo antes de
construir cualquier escritura. En modo interactivo cada entrada puede dirigirse
a un campo canónico libre, conservarse, eliminarse con confirmación adicional o
cancelar toda la actualización. Las elecciones solo mutan el plan en memoria;
`AGENTS.md` se escribe junto con la transacción y participa en el mismo rollback.
En `--yes`, `--non-interactive`, sin TTY o `--dry-run`, el comando informa todas
las entradas y alternativas, termina con salida `2` y deja el destino byte a
byte intacto.

El bloque delimitado es el **contrato administrado** y solo admite el esquema
canónico con sus IDs estables. Conservar una entrada es una elección explícita
que la retira de ese bloque y mantiene el bullet y sus continuaciones bajo
`## Reglas adicionales del proyecto`, fuera de los marcadores. La sección se
reutiliza si existe y la transformación es idempotente; esas reglas siguen
siendo instrucciones efectivas de `AGENTS.md`, aunque ya no sean parte del
contrato administrado.

El editor de `config.toml` entiende únicamente la forma inequívoca de `[agents]`
y las claves `max_concurrent_threads_per_session` o `max_threads`. Conserva BOM,
finales de línea, comentarios y el resto del archivo. Tablas o claves ambiguas,
UTF-8 inválido y strings TOML multilínea se derivan a edición manual sin escribir.
La ruta global se obtiene de `CODEX_HOME` o del directorio personal; las pruebas
siempre inyectan una raíz temporal. El valor objetivo es 12 como capacidad
técnica de Codex; los workflows aplican después sus topes independientes de 4
(`light`) y 9 (`full`).

## Flujo de orquestación V2

El runtime principal no interpreta Markdown. El orquestador posee la única
capacidad de mutación y los roles son productores aislados de reportes:

```mermaid
flowchart TD
    pre["EnvironmentProbe"] -->|verde| start["apply: start-session"]
    pre -->|rojo| stop["environment_failed<br/>sin snapshot"]
    start --> plan["AcceptanceContract<br/>versionado + hash"]
    plan --> dispatch["dispatch-attempt<br/>WorkEnvelope inmutable"]
    dispatch --> role["rol aislado<br/>sin capability"]
    role --> report["RoleReport estructurado"]
    report --> apply["apply: accept-role-report"]
    apply --> unit["unidad validada y consolidada"]
    unit --> lane["full:generation<br/>fingerprint único"]
    lane --> eval["evaluación combined o dual"]
    eval -->|violación vigente| rework["retrabajo acotado"]
    eval -->|finding nuevo crítico| scope["scope_decision_required"]
    eval -->|verde| doc["documenting o not_applicable"]
    doc --> close["completed + close-session"]
```

`StateStore` serializa cada sesión y publica snapshots atómicos;
`MemoryStateStore` ejecuta la misma suite pública que el adapter de filesystem.
`Clock` separa timestamps UTC de duración monotónica, `EnvironmentProbe`
comprueba el entorno antes del primer snapshot y `EventSink` conserva el log
append-only sin prompts, capacidades ni secretos.

La idempotencia se resuelve antes de CAS: el mismo `commandId` y payload devuelve
el resultado original; un payload distinto produce `idempotency_conflict`; un
comando nuevo con revisión vieja produce `stale_revision`. Un fallo del sink
posterior al snapshot no revierte una transición confirmada: se registra como
degradación observable. Cada evento se guarda primero en
`telemetry.pendingEvents` dentro del snapshot; un retry exacto completa ese
outbox sin repetir la transición. El sink JSONL relee los IDs durables antes de
append para deduplicar incluso después de reiniciar el proceso.

## Flujo de orquestación v1 (compatibilidad)

El diagrama siguiente documenta el controller Markdown conservado solo para
terminar sesiones v1 activas. Las sesiones nuevas no recorren esta ruta.

La política canónica decide primero con hechos observables; este diagrama
resume el enrutamiento y deja la lista cerrada de riesgos en
`.agents/policies/orquestacion.md`.

```mermaid
flowchart TD
    task["tarea"] --> explicit{"instrucción<br/>explícita?"}
    explicit -->|"orquestar / full"| full["modo full"]
    explicit -->|light| light["modo light"]
    explicit -->|sin orquestar| eligible{"¿cumple todos los<br/>límites directos?"}
    explicit -->|ninguna| risk{"¿señal cerrada<br/>de full?"}
    risk -->|sí| full
    risk -->|no| eligible
    eligible -->|sí| direct["ejecución directa<br/>verificada"]
    eligible -->|no| missing{"¿falta un hecho que<br/>cambiaría la categoría?"}
    missing -->|sí| ask["consultar solo<br/>ese hecho"]
    missing -->|no| stopDirect["detenerse y explicar<br/>el límite concreto"]
    full --> pre["preflight:<br/>CodeGraph · Engram ·<br/>subagentes · contrato"]
    light --> pre
    pre -->|falla| stop["detenerse con<br/>diagnóstico breve"]
    pre -->|pasa| sess["init DevSession:<br/>modo + capacidades +<br/>estrategia light"]
    sess --> topology{"¿light compacto?"}
    topology -->|no| plan["explorar y planificar<br/>DAG de 1–3 unidades"]
    topology -->|sí| bugcompact{"¿bugfix?"}
    bugcompact -->|sí| reproduce["Tester reproduce<br/>antes de planificar"]
    bugcompact -->|no| compactplan["Planificador absorbe exploración<br/>y declara 1 unidad writer"]
    reproduce --> compactplan
    compactplan --> compactimpl["Implementador:<br/>implemented + evidencia"]
    compactimpl --> compacteval["Evaluador combinado read-only:<br/>diff + criterios + validación focalizada"]
    compacteval --> compactapproved{"¿aprobado?"}
    compactapproved -->|no, máximo 2 ciclos| compactimpl
    compactapproved -->|sí: validated + consolidated<br/>+ fan-in + eje combined| docgate
    plan --> ready["seleccionar unidades listas<br/>y formar oleada"]
    ready --> open["open intento trazable:<br/>unidad · permiso · revisión · hilo"]
    open --> perm{"permiso"}
    perm -->|read-only| lane["carril aislado<br/>dentro del fan-out"]
    perm -->|writer| lock["reserva global única<br/>del working tree"]
    lane --> work["ejecutar rol"]
    lock --> work
    work --> impl["Implementador:<br/>implemented + evidencia"]
    impl --> strategy{"estrategia de validación<br/>registrada"}
    strategy -->|independent-rerun| rerun["repetir señal"]
    strategy -->|distinct-acceptance-check| distinct["señal de aceptación<br/>distinta"]
    strategy -->|verified-evidence-reuse| reuse["revisar vigencia,<br/>diff y cobertura"]
    rerun --> test["Tester juzga y produce<br/>evidencia atribuible"]
    distinct --> test
    reuse --> test
    test --> green{"validada?"}
    green -->|no| rework["fallo + causa + impacto<br/>nuevo intento"]
    rework --> invalidate["invalidar ejes<br/>y subir generación"]
    invalidate --> ready
    green -->|sí| consolidated["validated + consolidated<br/>cerrar hilo"]
    consolidated --> all{"¿todas las unidades?"}
    all -->|no| ready
    all -->|sí| fanin["fan-in de la<br/>generación vigente"]
    fanin --> fulltest["validación integrada<br/>según la política"]
    fulltest --> axes["evaluación según<br/>estrategia registrada"]
    axes --> approved{"¿todos los ejes<br/>aprobados?"}
    approved -->|no| rework
    approved -->|sí| docgate{"¿documentación o<br/>memoria durable?"}
    docgate -->|sí| document["Documentador"]
    docgate -->|no| nodoc["registrar No aplica"]
    document --> close["consolidar Engram<br/>cleanup + close"]
    nodoc --> close
```

El ciclo Evaluador → Implementador admite **dos** retrabajos como máximo; si el
rechazo persiste, la tarea se detiene y se presenta el diagnóstico.

Cada fase corre aislada y devuelve sólo su contrato de salida. El orquestador es
el único que habla con el usuario: los roles no se coordinan entre sí ni amplían
el alcance.

`architecture` tiene un cierre distinto: explora, compara, obtiene aprobación
explícita y registra la decisión. Si no hay implementación, termina allí. Si la
hay, transfiere la decisión una sola vez a `feature` o `refactor`; ese workflow
posterior asume en exclusiva implementación, testing, evaluación y documentación
final.

### Presupuesto, capacidad y aislamiento

La capacidad se compone y no se representa con un único número:

| Dimensión | Semántica |
| --- | --- |
| Capacidad técnica de Codex | Hasta 12 hilos de subagentes; habilita, pero no cambia la política |
| Presupuesto `light` | Máximo 4 subagentes activos |
| Presupuesto `full` | Máximo 9 subagentes activos |
| Capacidad de plataforma | Disponibilidad real detectada en el host |
| Capacidad `read-only` | Carriles de lectura simultáneos, acotados por modo y plataforma |
| Aislamiento de escritores | Uno por working tree sin worktrees aislados aprobados |

El Orquestador no cuenta en 4/9. La capacidad total de agentes es el mínimo
entre modo y plataforma; la capacidad efectiva de una fase añade el trabajo
listo y los topes del rol. Los carriles `read-only` y writers consumen el total,
pero se contabilizan por separado: un writer no ocupa el cupo de lectura y un
lector no ocupa aislamiento de escritura. Con menos capacidad se reduce el
fan-out usando agentes reales; no se simulan agentes ni se sustituyen por
procesos auxiliares.

El presupuesto `light` sigue siendo un techo de capacidad. La estrategia
compacta reduce la topología real y normalmente abre un solo contexto por fase;
no intenta ocupar cuatro carriles ni crea Explorador o Tester posterior cuando
su marcador no los declara.

### Unidades, intentos, DAG y gates

El Planificador registra de una a tres unidades verticales en `full` y `light`
legacy. En compacto registra exactamente una unidad writer, sin dependencias y
con `focusedValidation`. Cada unidad guarda `workUnitId`,
`acceptanceCriteria`, `dependsOn`, `ownedPaths`, `permission` y `wave`. El
controlador rechaza contratos incompletos, IDs duplicados, dependencias
ausentes, ciclos y colisiones antes de crear la DevSession.

La unidad y el intento son identidades distintas. La primera representa el
trabajo a través de sus retrabajos; el segundo es una ejecución monotónica de
fase y rol con `baseRevision`, `threadId`, criterios, permiso, causa e intento
anterior. Un intento terminal es inmutable. Una unidad validada sólo se reabre
con impacto demostrado.

En la ruta separada los gates son mecánicos:

1. el Implementador consolida evidencia y deja la unidad `implemented`;
2. el Tester sólo puede abrir sobre ese estado y la deja `validated` o
   `failed`;
3. una validación verde la deja además `consolidated` y puede satisfacer
   `dependsOn`.

La evidencia focalizada pertenece a la unidad y el reporte del Tester conserva
la autoridad del gate. En compacto, el Evaluador combinado abre directamente
sobre `implemented` y su veredicto actualiza de forma atómica unidad, fan-in y
eje `combined`; no existe un Tester posterior. La selección de estrategia, su
vigencia y el momento de la validación integrada pertenecen a la
[política de orquestación](../.agents/policies/orquestacion.md), no a este
documento. El controlador persiste únicamente el estado necesario para rechazar
transiciones o evidencia obsoletas; no añade otra máquina para reinterpretar la
decisión humana.

Las oleadas se derivan del DAG y contienen únicamente unidades listas. La
propiedad de rutas writer es exclusiva y portable: se normalizan rutas
relativas, se rechazan escapes y se detectan colisiones exactas o de
ancestro/descendiente, incluidas mayúsculas y aliases terminales de Windows.

### Proyección de contexto y traspaso de reportes

La DevSession global es el ledger durable y recuperable. No se carga en cada
contexto aislado: `open` proyecta una SubDevSession autocontenida con objetivo,
reglas, tareas, hallazgos y una lista ordenada `contextPaths`. El controlador
calcula `sourceRevision` desde la revisión global vigente, valida rutas relativas
portables y rechaza índices protegidos, directorios, escapes, aliases y
duplicados antes de escribir.

El despacho normal contiene únicamente la ruta de la SubDevSession, la
instrucción breve de ejecutar el contrato del rol y acceso a CodeGraph y Engram.
El rol lee solo ese sobre y las referencias seleccionadas; no recibe cuerpos
copiados. Ante un dato indispensable ausente devuelve la incógnita exacta. El
orquestador puede fallar el intento y abrir otro con causa y contexto corregido,
pero nunca reescribe retrospectivamente un sobre activo.

`commit` escribe el cuerpo contractual íntegro solo en la SubDevSession. La
parte humana global añade una referencia de tamaño acotado con identidad,
atribución, resultado, hash y ruta; el bloque administrado global sigue siendo
dueño de revisiones, gates, evidencia y evaluación. Por eso `status` no necesita
abrir los sobres ni cargar sus cuerpos.

La política canónica selecciona `contextPaths` mínimos para cada rol. Evaluador
sigue siendo obligatorio. Documentador se abre después de la aprobación sólo si
hay documentación afectada o una interfaz pública, un artefacto contractual,
una decisión durable o memoria validada pendiente; en otro caso se registra `No
aplica` sin crear el contexto. `cleanup` espera todos los consumos que realmente
se abrieron. Las DevSessions y SubDevSessions heredadas se leen y consolidan sin
reescribir su parte humana.

### Writer lock, recuperación e idempotencia

El aislamiento writer no es local a una DevSession. El controlador deriva la
identidad canónica del working tree y publica por hard link un único archivo
`.writer-<workingTreeId>.lock`. Su dueño exacto contiene `session`, `attempt` y
`workingTreeId`, por lo que dos DevSessions del mismo árbol compiten por la
misma reserva aunque declaren rutas diferentes.

Una transición inicial y la reparación de un checkpoint liberan de forma
estricta: un dueño distinto es conflicto. Cuando `commit` o `fail` ya están
terminales y el mismo payload se repite, la operación sigue siendo idempotente
pero libera sólo si la reserva todavía coincide exactamente. Si un writer
sucesor ya la adquirió, el reintento devuelve éxito sin eliminar, modificar ni
reclamar su lock. Si una interrupción dejó el lock en el intento original, el
checkpoint recuperado sí lo libera.

`status` y `recover` son de sólo lectura. Los temporales de publicación se
eliminan en la propia adquisición y los residuos ambiguos nunca se borran por
edad. `cleanup` continúa limitado a sobres acusados y `safe_to_delete`.

### Fan-in, generaciones y sesiones heredadas

En la ruta separada, el controlador sólo marca la integración lista cuando todas
las unidades están validadas y consolidadas. En compacto, el Evaluador combinado
puede abrir sobre la única unidad implementada y una aprobación produce
simultáneamente consolidación y fan-in. El controlador persiste estrategia,
riesgo y generación, valida sus valores ejecutables y, al reabrir una unidad,
incrementa la generación e invalida resultados anteriores. La política canónica
es la única propietaria de la elegibilidad humana de cada estrategia y de las
categorías admitidas; esta sección documenta únicamente el estado y las
transiciones del controlador.

Las DevSessions v1 sin unidades conservan su comportamiento. Una sesión por
unidades creada antes de que existieran criterios, capacidades separadas,
estrategia o generación falla cerradamente antes de `open` cuando le falta la
trazabilidad exigida. Repetir `init` con el plan aprobado completa únicamente
esos campos ausentes, preserva intentos, estados, ownership y evidencia, y es
byte-idempotente al volver a ejecutarse. Una sesión `full` heredada sin estrategia
conserva dual implícito. Una sesión `light` sin `lightStrategy` conserva la ruta
separada legacy; solo las nuevas registran `compact`, sin migración implícita. El
modelo base está en
[ADR 0009](adr/0009-paralelismo-controlado-por-unidades.md) y la simplificación
vigente en [ADR 0010](adr/0010-cierre-y-evaluacion-proporcionales-al-riesgo.md);
ambas extienden el controlador portable de
[ADR 0008](adr/0008-controlador-portable-de-subdevsessions.md).

## Compatibilidad y migración v1→v2

`inspect` busca primero un snapshot V2 y, si no existe, delega en
`LegacyV1Adapter`. El adapter puede mostrar una `SessionView` normalizada, pero
marca `legacyAmbiguous` cuando la prosa no demuestra un veredicto; nunca inventa
actor, tiempos, threat model ni aprobación histórica.

`migrate-v1` siempre ofrece dry-run, registra el hash de origen y es
idempotente. Una sesión con writer o reporte pendiente exige checkpoint: puede
terminar en v1, migrarse cuando quede inactiva o cerrarse y reiniciarse mediante
una decisión explícita. Una migración ambigua entra en
`scope_decision_required`.

Las sesiones nuevas escriben V2. El fallback de escritura v1 pertenece a la
configuración de rollout y no convierte sesiones V2 activas hacia atrás. El
lector v1 no se retira antes del 2026-11-17 ni hasta completar dos releases
estables y llegar a cero sesiones v1 activas en consumidores prioritarios. La
fecha y la condición acumulativa se publican en `.agents/protocol.json`.

## Frontera de distribución

Lo que viaja en el paquete está declarado dos veces —en el código y en
`package.json`— y el inicializador falla si las dos listas no coinciden. Además,
la conformidad exige que kernel, políticas, roles, workflows, templates y
schemas declaren protocolo 2 como conjunto indivisible.

| Categoría | Ejemplos | Viaja |
| --- | --- | --- |
| Inventario canónico | `.agents/`, `.codex/`, `.claude/`, `CLAUDE.md` | Sí |
| Soporte de la distribución | `AGENTS.md`, `README.md`, `LICENSE`, `package.json`, `bin/`, `scripts/` | Sí |
| Assets de distribución | `gitignore.asset` ×2 | Sí, con nombre neutro |
| Estado del proyecto | `.agents/VERSION`, DevSessions reales, `*.local.json` | No |
| Herramientas locales | `.codegraph/`, `.engram/`, `node_modules/`, `*.tgz` | No |
| Desarrollo de la plantilla | `tests/`, `.gitignore` | No |
| Documentación interna | `CONTEXT.md`, `docs/` | No |

Dos consecuencias que sorprenden al leer el código:

- **`.gitignore` no puede distribuirse con su nombre.** npm renombra a
  `.npmignore` cualquier `.gitignore` empaquetado, así que los dos que la capa
  instala viajan como `gitignore.asset` y el inicializador restaura el nombre
  canónico al copiarlos.
- **Los enlaces a documentación interna sólo se comprueban aquí.** La
  integridad estructural resuelve todos los enlaces Markdown del inventario,
  pero omite los que apuntan a rutas exclusivas del desarrollo cuando corre
  desde un paquete instalado, donde esas rutas no existen — ver
  [ADR 0006](adr/0006-documentacion-interna-fuera-de-la-distribucion.md).

## Contrato de proyecto

El inicializador crea, completa o reemplaza únicamente el bloque delimitado, y
conserva literalmente todo lo que haya antes y después:

```markdown
<!-- AGENTIC_PROJECT_CONTRACT_START -->

## Desarrollo
- Activación de la Regla de Oro para cambios de código o pruebas

## Proyecto
- Propósito / Arquitectura / Entrypoints

## Validación
- Focalizada / Completa

## Tests
- Framework / Ubicación / Ciclo de vida

## Git
- Rama o estrategia permitida

## Seguridad
- Secretos / Rutas protegidas / Datos inmutables / Acciones restringidas /
  Contaminación de origen

## Documentación
- README y documentación técnica / ADRs

<!-- AGENTIC_PROJECT_CONTRACT_END -->
```

Solo el marcador generado `<pendiente: …>`, el placeholder histórico admitido,
un valor vacío o uno que empiece por `TODO`, `pendiente`, `por definir` o `TBD`
cuenta como ausente. Los autolinks y otros valores explícitos con ángulos no son
placeholders. La regla
`STRICT_PROJECT_CONTRACT_RULE` de `.agents/policies/orquestacion.md` lo cobra y
detiene la orquestación indicando archivo, sección y campo exactos. El
propietario puede flexibilizar o eliminar ese bloque delimitado; hacerlo cambia
una garantía de la capa deliberadamente.

Un `AGENTS.md` anidado redefine para su sector Proyecto, Validación, Tests y
Documentación. Nunca debilita seguridad, requisitos de herramientas ni
orquestación: esas restricciones se acumulan y prevalece la más estricta.

## Deuda de vocabulario conocida

Dos nombres del código no siguen el glosario y se conservan a propósito para no
romper la interface pública:

- La salida del plan usa `validar:` para «el archivo ya coincide con el
  canónico», mientras que `Validación` en el contrato significa la evidencia
  del proyecto. Son cosas distintas con la misma palabra; el segundo sentido es
  el canónico.
- `PACKAGE_FILES` nombra lo que el glosario llama inventario canónico. Los
  tests lo importan con ese nombre.
