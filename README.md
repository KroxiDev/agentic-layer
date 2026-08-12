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

### Opciones

| Opción | Efecto |
| --- | --- |
| `--target <ruta>` | Destino distinto del directorio actual |
| `--dry-run` | Calcula el plan completo y no escribe nada |
| `-y`, `--yes` | Omite la confirmación previa a escribir |
| `--force` | Reemplaza una capa instalada y borra sus residuos |
| `--purpose <texto>` | Declara el propósito en vez de dejarlo pendiente |
| `--git-strategy <texto>` | Declara la estrategia Git en vez de dejarla pendiente |
| `--init-codegraph` | Confirma explícitamente `codegraph init` en el destino |
| `--update-codegraph` | Confirma explícitamente `codegraph sync` en el destino |
| `-v`, `--version` · `-h`, `--help` | Versión de la distribución · ayuda |

`--force` está acotado a los archivos canónicos divergentes y a los residuos de
versiones anteriores. No reemplaza enlaces simbólicos ni directorios, no
reescribe `AGENTS.md` —ni dentro ni fuera del contrato— y no toca las
DevSessions.

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
contextos aislados con modos `full` y `light`, DevSession como único traspaso de
estado, SDD proporcional con TDD por comportamiento, diagnóstico falsable de
bugs, historial durable en Engram, inteligencia de código en CodeGraph y adapters
nativos delgados para Codex y Claude Code.

No trae producto, rama ni layout de código. No instala herramientas, no ejecuta
agentes por su cuenta, no gestiona Git ni remotos y no se sincroniza sola: la
adopción es una copia y el propietario la mantiene.

## Modos de orquestación

| Modo | Activación | Profundidad |
| --- | --- | --- |
| `full` | Predeterminado; automático para tareas no triviales | Workflow completo, SDD proporcional, TDD cuando corresponda y validación declarada |
| `light` | Sólo por petición explícita | Mismos roles, workflow y DevSession; cambio y evidencia focalizados |

`light` no selecciona modelo ni nivel de razonamiento. Por defecto no crea tests,
no ejecuta la suite completa, no refactoriza y no amplía documentación. Conserva
los contextos aislados, la revisión del diff, la evidencia de validación y todas
las restricciones de seguridad. Si el impacto parece considerable, el orquestador
recomienda `full` y pide una decisión informada antes de continuar.

Una tarea trivial, local y evidente se resuelve sin pipeline. Si la
clasificación es dudosa, se consulta antes de actuar.

## Roles y workflows

Cada rol declara entradas, proceso, salida y límites en `.agents/roles/`, corre
en un contexto aislado y devuelve sólo su contrato de salida. No hablan con el
usuario ni entre sí: el orquestador es el único interlocutor.

| Rol | Responsabilidad | Puede escribir |
| --- | --- | --- |
| **Explorador** | Delimita el sector de importancia y las reglas efectivas | Nada |
| **Planificador** | Convierte el objetivo en especificación verificable | Nada |
| **Implementador** | Aplica el cambio mínimo dentro del sector aprobado | Código y tests |
| **Tester** | Verifica criterios con evidencia exacta | Sólo tests autorizados |
| **Evaluador** | Aprueba o devuelve cambios concretos | Nada |
| **Documentador** | Deja la documentación consistente y consolida memoria | Documentación |

| Workflow | Secuencia |
| --- | --- |
| `feature` | explorar → planificar → implementar → testear → evaluar → documentar |
| `bugfix` | reproducir → diagnosticar → planificar → corregir → verificar → evaluar → documentar |
| `refactor` | explorar → definir invariantes → implementar → testear → evaluar → documentar |
| `architecture` | explorar → comparar → proponer decisión → **aprobación del usuario** → implementar con otro workflow → evaluar → documentar |

El Evaluador puede devolver trabajo al Implementador dos veces como máximo; si el
rechazo persiste, la tarea se detiene con un diagnóstico.

**Con Codex:** abrir el proyecto desde su raíz y pedir `orquestar <tarea>`, o
describir una tarea no trivial para la activación automática. Los roles se
descubren en `.codex/agents/*.toml`.

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
bin/ scripts/       ejecutable `agentic` e inicializador sin dependencias
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
| `cambió después del plan`, salida `2` | Un editor u otro proceso escribió durante la ejecución | Cerrar lo que esté escribiendo y repetir |
| Error de destino, salida `1` | El destino es la raíz del sistema, el directorio personal, o su ancestro es un enlace simbólico | Elegir otro destino |
| Una tarea orquestada se detiene por contrato incompleto | Quedan campos pendientes en `AGENTS.md` | Completarlos con la skill `agentic-grilling`, que es donde hay contexto para decidirlos |
| No aparecen los agentes ni `/orquestar` | El proyecto no se abrió desde su raíz | Reabrirlo en la raíz, donde viven `AGENTS.md` y los adapters |
| El Evaluador parece poder editar | La sesión padre corre en `acceptEdits`, `auto` o `bypassPermissions` y prevalece sobre el subagente | Usar el modo por defecto cuando se necesite aislamiento estricto |
| Una segunda adopción no reconoce la capa previa | `.agents/VERSION` no está versionado | Versionarlo: es la única marca de la versión instalada |

Códigos de salida: `0` correcto · `1` error de uso · `2` colisión sin escrituras
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
node --test tests/agentic-init.test.mjs
node scripts/agentic-init.mjs --dry-run --yes
npm pack --dry-run
~~~

La suite crea y elimina sus propios directorios temporales, y nunca toca el
registro de npm.

## Licencia

[MIT](LICENSE).
