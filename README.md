# Capa agéntica reusable

Proceso de desarrollo asistido por agentes que se adopta en cualquier repositorio con un solo comando.

## Inicio rápido

Desde la raíz del repositorio que quiera adoptar la capa:

~~~text
npx --yes github:KroxiDev/agentic-layer init .
~~~

Eso es todo, y es literal: el comando no pregunta ningún hecho del proyecto.
Detecta lo que puede, copia el inventario canónico, genera el contrato de
`AGENTS.md`, marca como `<pendiente: …>` lo que no pudo inferir y resume qué
quedó listo, qué falta completar y qué requiere una acción manual. Antes de
escribir muestra el plan y pide confirmación en una terminal interactiva.

Para ver el plan sin tocar el disco, añadir `--dry-run`. El paquete no se instala
como dependencia: `npx` lo ejecuta una vez y no queda ningún vínculo con él.

Como alternativa, **Use this template** en GitHub y luego
`node scripts/agentic-init.mjs` desde la copia local. El resultado en el proyecto
adoptante es el mismo; la copia completa incluye además `tests/` y la
documentación interna, que el paquete no distribuye.

## Actualizar una capa existente

Desde la raíz de un proyecto que ya tenga la capa, ejecutar:

~~~text
npx --yes github:KroxiDev/agentic-layer update .
~~~

`update` detecta instalaciones con o sin `.agents/VERSION`, muestra cada copia,
reemplazo y residuo antes de escribir, migra el contrato de `AGENTS.md` sin
perder sus hechos explícitos y aplica la capa como una transacción recuperable.
Los adapters y archivos canónicos se reparan aunque la versión ya coincida;
las DevSessions y los archivos ajenos se conservan. Una versión instalada más
nueva se bloquea salvo autorización expresa con `--allow-downgrade`.

Si el contrato histórico contiene campos o bullets que no corresponden al
esquema canónico, una terminal interactiva pide resolver **cada** entrada antes
de escribir: mapear su valor a un campo canónico libre, conservar el bullet y
sus continuaciones como regla adicional, eliminarlo con una confirmación extra
o cancelar. Un destino canónico ocupado nunca se sobrescribe ni se fusiona; se
informa el conflicto y se vuelve a pedir una decisión.

El contrato administrado es únicamente el contenido delimitado por
`AGENTIC_PROJECT_CONTRACT_START` y `AGENTIC_PROJECT_CONTRACT_END`. La elección
explícita de conservar mueve la entrada fuera de esos marcadores, bajo
`## Reglas adicionales del proyecto`; esa sección sigue siendo parte efectiva
de `AGENTS.md`, se reutiliza si ya existe y no se duplica al repetir `update`.
Con `--yes`, `--non-interactive`, sin TTY o con `--dry-run`, estas entradas no se
deciden automáticamente: se informan todas, el destino queda idéntico y el
comando termina con salida `2`.

La configuración de Codex es una operación opcional posterior. Para habilitar
capacidad técnica de hasta 12 subagentes se puede elegir `--codex-config global`,
`local` o `none`; `--yes` por sí solo nunca autoriza esa escritura. La capacidad
técnica no modifica los presupuestos de trabajo definidos por la política. La
configuración local prevalece sobre la global y un valor efectivo de 12 o más no
se reduce ni se reescribe. Si el TOML es ambiguo o contiene strings multilínea,
queda pendiente de edición manual y se conserva byte a byte. Las escrituras autorizadas son
atómicas y revalidan los ancestros no-follow antes del temporal y de la mutación
final.

### Opciones

| Opción | Efecto |
| --- | --- |
| `--target <ruta>` | Destino distinto del directorio actual |
| `--dry-run` | Calcula el plan sin escribir; si hay entradas no mapeables, las informa y termina con salida `2` |
| `-y`, `--yes`, `--non-interactive` | Omite la confirmación general; no decide entradas contractuales no mapeables |
| `--force` | Reemplaza una capa instalada y borra sus residuos |
| `--allow-downgrade` | Solo en `update`: autoriza instalar una versión anterior a la declarada |
| `--codex-config global\|local\|none` | Solo en `update`: decide explícitamente si habilitar capacidad técnica para 12 subagentes en Codex |
| `--purpose <texto>` | Declara el propósito en vez de dejarlo pendiente |
| `--git-strategy <texto>` | Declara la estrategia Git en vez de dejarla pendiente |
| `--init-codegraph` | Confirma explícitamente `codegraph init` en el destino |
| `--update-codegraph` | Confirma explícitamente `codegraph sync` en el destino |
| `-v`, `--version` · `-h`, `--help` | Versión de la distribución · ayuda |

`--force` está acotado a los archivos canónicos divergentes y a los residuos de
versiones anteriores. No reemplaza enlaces simbólicos ni directorios, no
autoriza por sí mismo escrituras adicionales en `AGENTS.md` y no toca las
DevSessions. Solo una elección interactiva explícita puede añadir contenido
fuera del contrato administrado.

### Requisitos

| Requisito | Cuándo hace falta |
| --- | --- |
| **Node.js 20+** | Para ejecutar el comando. No instala paquetes ni declara dependencias |
| **CodeGraph** con índice vigente | Para orquestar. El comando lo comprueba y reclama si falta |
| **Engram** disponible | Para orquestar, con ámbito de proyecto |
| **Subagentes nativos** en Codex o Claude Code | Para orquestar |
| **Contrato `AGENTS.md`** completo | Para orquestar; el comando lo genera y lista lo que falta |

Sólo el primero es necesario para adoptar la capa. Si CodeGraph o Engram faltan,
los archivos se copian igual y el comando termina con código `4` indicando qué
instalar: la capa queda instalada pero no puede orquestar nada.

## Objetivo

Un repositorio no necesita reinventar cómo trabaja con agentes. Esta capa fija
ese proceso una vez y lo hace adoptable: qué roles existen, en qué orden
intervienen, qué evidencia exige cada fase y qué hechos del proyecto necesita
conocer.

Ofrece seis roles con contratos de salida, cuatro workflows, orquestación en
contextos aislados con modos `full` y `light`, unidades verticales con
paralelismo controlado, DevSession como único traspaso de estado, SDD
proporcional con TDD por comportamiento, gates de validación y documentación
condicionados por evidencia, diagnóstico falsable de bugs,
historial durable en Engram, inteligencia de código en CodeGraph y adapters
nativos delgados para Codex y Claude Code.

No trae producto, rama ni layout de código. No instala herramientas, no ejecuta
agentes por su cuenta, no gestiona Git ni remotos y no se sincroniza sola: la
adopción es una copia y el propietario la mantiene.

## Activación y modos

| Ejecución | Uso |
| --- | --- |
| Directa verificada | Trabajo elegible para los límites directos de la política. |
| `light` | Capa activada con intensidad reducida por petición explícita. |
| `full` | Capa activada con el workflow completo exigido por su clasificación. |

La matriz normativa vive una sola vez en
la [política de orquestación](.agents/policies/orquestacion.md). Allí viven la
activación, los presupuestos, los modos, la validación y el cierre; las reglas
TDD se derivan a la [política SDD/TDD](.agents/policies/sdd-tdd.md) y su
[skill canónica](.agents/skills/agentic-tdd/SKILL.md). Este README describe la
interface sin volver a enumerar categorías, límites o excepciones.

### Paralelismo controlado

El orquestador no cuenta dentro de los topes del modo. La capacidad efectiva es
el mínimo entre el tope del modo, la capacidad disponible de la plataforma y el
trabajo listo. Los carriles `read-only` y el aislamiento de escritores se
calculan por separado: un writer no consume por sí mismo el cupo de lectura, y
la capacidad técnica 12 de Codex nunca obliga a llenar 12 hilos.

Una planificación puede declarar entre una y tres **unidades de
implementación** verticales. La unidad es el trabajo durable (`workUnitId`,
criterios, `dependsOn`, oleada y rutas propias); cada ejecución o retrabajo es
un **intento** nuevo con permiso, revisión base e hilo trazables. El DAG sólo
habilita unidades cuyas dependencias ya fueron validadas y forma oleadas
deterministas con el trabajo listo.

Cada unidad atraviesa tres gates:

1. el Implementador la deja `implemented`;
2. un Tester juzga la evidencia, le atribuye validación y la deja `validated`;
3. el bloque administrado global la deja `consolidated` y su índice enlaza la
   evidencia atribuible.

El Planificador registra la estrategia de validación de cada unidad y el Tester
juzga su evidencia. Las opciones, condiciones de reutilización y reglas de
vigencia pertenecen exclusivamente a la política canónica.

Cada reporte contractual íntegro vive una sola vez, en la SubDevSession de su
intento. La parte humana de la DevSession global guarda únicamente una referencia
compacta y el bloque administrado conserva el estado que consulta `status` sin
leer cuerpos. Antes de `cleanup`, el orquestador pasa al Evaluador y al
Documentador, cuando su gate se abre, solo las rutas de los sobres pertinentes
para su fase.

Una dependencia sólo se satisface en el segundo gate. Una unidad ya validada no
se repite sin impacto demostrado. Cada ruta editable tiene propietario
exclusivo y sólo existe un writer activo por working tree, reservado mediante un
lock global compartido por todas sus DevSessions. Implementadores y Testers que
escriben se serializan; la exploración y la evaluación de solo lectura pueden
usar fan-out cuando sus carriles son independientes.

El controlador hace cumplir gates, integración, estrategia y generación según
el estado registrado; la política canónica decide cuándo son elegibles y qué
evidencia exige el cierre. Un reintento terminal idéntico de `commit` o `fail`
es idempotente y sólo libera la reserva de writer si todavía pertenece
exactamente a su sesión e intento; nunca toca la de un sucesor.

Las DevSessions anteriores al modelo por unidades siguen siendo compatibles.
`status` no escribe y `init` puede completar de forma explícita, monotónica e
idempotente la trazabilidad que falte antes de abrir nuevos intentos. `recover`
expone checkpoints y residuos sin decidir por antigüedad; cuando una
interrupción dejó la reserva en el intento original, el reintento la libera al
completar el checkpoint.

## Roles y workflows

Cada rol declara entradas, proceso, salida y límites en `.agents/roles/`, corre
en un contexto aislado y devuelve sólo su contrato de salida. No hablan con el
usuario ni entre sí: el orquestador es el único interlocutor.

| Rol | Responsabilidad | Puede escribir |
| --- | --- | --- |
| **Explorador** | Delimita el sector de importancia y las reglas efectivas | Nada |
| **Planificador** | Convierte el objetivo en especificación verificable y elige la estrategia por unidad | Nada |
| **Implementador** | Aplica el cambio mínimo y entrega evidencia reproducible | Código y tests |
| **Tester** | Juzga los criterios y es el único que valida la unidad | Sólo tests autorizados |
| **Evaluador** | Aprueba o devuelve cambios concretos | Nada |
| **Documentador** | Si su gate se abre, deja la documentación consistente o consolida memoria durable | Documentación |

| Workflow | Secuencia |
| --- | --- |
| `feature` | explorar → planificar → implementar → testear → evaluar → documentar si aplica |
| `bugfix` | reproducir → diagnosticar → planificar → corregir → verificar → evaluar → documentar si aplica |
| `refactor` | explorar → definir invariantes → implementar → testear → evaluar → documentar si aplica |
| `architecture` | explorar → comparar → proponer decisión → **aprobación del usuario** → registrar; si debe implementarse, transferir una vez a `feature` o `refactor` |

Una tarea exclusivamente arquitectónica termina al registrar la decisión
aprobada. Si hay implementación, el workflow posterior es el único responsable
de implementar, testear, evaluar y documentar el resultado final; `architecture`
no repite ese cierre.

El Evaluador puede devolver trabajo al Implementador dos veces como máximo; si el
rechazo persiste, la tarea se detiene con un diagnóstico.

Documentador también tiene un gate: se abre solo si el cambio deja documentación
incorrecta, el contrato exige un artefacto, hay una decisión durable o queda un
candidato validado para Engram. Si nada aplica, la DevSession registra `No
aplica` con el motivo y no crea ese contexto. Por ejemplo, un ajuste interno sin
documentación ni memoria pendiente puede cerrar después de la evaluación; un
cambio de interfaz pública sigue abriendo Documentador. «Condicional» se
basa en evidencia y riesgo, no en comodidad.

**Con Codex:** abrir el proyecto desde su raíz y pedir `orquestar <tarea>`, o
describir la tarea para que la política canónica decida entre ejecución directa
y activación automática por riesgo. Los roles se descubren en
`.codex/agents/*.toml`.

**Con Claude Code:** abrir el proyecto desde su raíz para que `CLAUDE.md` importe
`AGENTS.md`, y ejecutar `/orquestar <tarea>`. Los roles se descubren en
`.claude/agents/*.md`.

## Estructura

~~~text
.agents/            NÚCLEO: única fuente de verdad del proceso
  policies/         orquestación, SDD/TDD y Regla de Oro de código y pruebas
  roles/            los seis roles
  scripts/          controlador portable de DevSession y SubDevSessions
  workflows/        feature · bugfix · refactor · architecture
  skills/           orquestar · grilling · tdd · diagnóstico de bugs
  templates/        dev-session.md · subdev-session.md
  sessions/         DevSessions globales y sobres efímeros (ignorados por Git)
AGENTS.md           SEAM: reglas globales + contrato del proyecto
.codex/ .claude/    ADAPTERS delgados que apuntan a las rutas canónicas
CLAUDE.md           import fijo de AGENTS.md
bin/ scripts/       ejecutable `agentic` y motor de init/update sin dependencias
tests/              especificación ejecutable de la CLI
~~~

El árbol completo, los diagramas de flujo, el mapa de módulos y la frontera de
distribución están en [docs/arquitectura.md](docs/arquitectura.md).

## Errores comunes

| Síntoma | Causa | Arreglo |
| --- | --- | --- |
| `Colisiones detectadas`, salida `2` | Una ruta canónica está ocupada por un archivo ajeno al inventario | Revisar el archivo listado; moverlo, o usar `--force` si es una capa instalada |
| `Se detectó una capa agéntica`, salida `2` | Hay divergencias y no hay terminal para preguntar (`--yes`, CI) | Repetir con `--force` para reemplazar |
| `--force no reemplaza enlaces simbólicos, directorios` | Un directorio o enlace ocupa una ruta canónica | Eliminarlo a mano; `--force` nunca lo hace por su cuenta |
| `REQUISITOS FALTANTES: CodeGraph`, salida `4` | Falta el ejecutable o el índice del repositorio | Instalar `codegraph` y ejecutar `codegraph init`, o repetir con `--init-codegraph` |
| `REQUISITOS FALTANTES: Engram`, salida `4` | Falta el ejecutable o no identifica el proyecto | Instalar `engram` y registrarlo en el host de agentes |
| `marcadores contractuales incompletos o duplicados`, salida `2` | `AGENTS.md` tiene los marcadores del contrato duplicados o a medias | Dejar un solo par `..._START` / `..._END`; el archivo no se modifica |
| `entradas contractuales no mapeables`, salida `2` | `update` se ejecutó con `--yes`, `--non-interactive`, sin TTY o con `--dry-run` y el contrato contiene campos ajenos al esquema | Repetir en una terminal interactiva y mapear, conservar fuera del contrato, eliminar o cancelar cada entrada |
| `No se detectó una capa agéntica existente`, salida `2` | Se ejecutó `update` sobre un proyecto sin capa | Usar `agentic init [destino]` |
| Versión posterior o `.agents/VERSION` inválido, salida `2` | El downgrade no fue autorizado o la marca no es SemVer válida | Revisar la versión; usar `--allow-downgrade` solo si se desea bajar explícitamente |
| `edición manual` para Codex | El TOML, su codificación o su ruta no pueden editarse de forma conservadora | Editar la ruta informada; la actualización de la capa ya quedó aplicada |
| `cambió después del plan`, salida `2` | Un editor u otro proceso escribió durante la ejecución | Cerrar lo que esté escribiendo y repetir |
| Error de destino, salida `1` | El destino es la raíz del sistema, el directorio personal, o su ancestro es un enlace simbólico | Elegir otro destino |
| Una tarea orquestada se detiene por contrato incompleto | Quedan campos pendientes en `AGENTS.md` | Completarlos con la skill `agentic-grilling`, que es donde hay contexto para decidirlos |
| No aparecen los agentes ni `/orquestar` | El proyecto no se abrió desde su raíz | Reabrirlo en la raíz, donde viven `AGENTS.md` y los adapters |
| El Evaluador parece poder editar | La sesión padre corre en `acceptEdits`, `auto` o `bypassPermissions` y prevalece sobre el subagente | Usar el modo por defecto cuando se necesite aislamiento estricto |
| Una segunda adopción no reconoce la capa previa | `.agents/VERSION` no está versionado | Versionarlo: es la única marca de la versión instalada |

Códigos de salida: `0` correcto · `1` error de uso · `2` bloqueo seguro sin escrituras
· `3` cancelado por el usuario · `4` capa instalada con requisitos ausentes. Un
contrato con campos pendientes **no** cambia el código de salida: la adopción se
completó y quien bloquea después es el preflight de la orquestación.

## Documentación

- [CONTEXT.md](CONTEXT.md) — glosario del dominio y lenguaje ubicuo.
- [docs/arquitectura.md](docs/arquitectura.md) — estructura, flujos y frontera de
  distribución.
- [docs/adr/](docs/adr/) — decisiones arquitectónicas y sus trade-offs.
- [.agents/README.md](.agents/README.md) — el módulo interno y sus invariantes.

`CONTEXT.md` y `docs/` documentan el mantenimiento de esta plantilla y no viajan
en el paquete.

### Validar la capa

~~~text
node --check scripts/agentic-init.mjs
node --check bin/agentic.mjs
node --test
node scripts/agentic-init.mjs --dry-run --yes
npm pack --dry-run
~~~

`node:test` descubre los archivos por interfaz y los ejecuta en paralelo. Cada
archivo usa un directorio raíz temporal exclusivo y autolimpiable; la suite
nunca toca el registro de npm.

## Licencia

[MIT](LICENSE).
