# Capa agéntica reusable

Repositorio declarativo para incorporar un proceso de desarrollo asistido por
agentes en proyectos que usan Codex, Claude Code o ambos. El núcleo vive en
`.agents/`; cada proyecto aporta sus hechos y restricciones únicamente mediante
`AGENTS.md`. La adopción normal requiere solo dos acciones:

1. Pulsar **Use this template** en GitHub.
2. Ejecutar `node scripts/agentic-init.mjs` desde la raíz de la copia local.

## Propósito y límites

La capa ofrece:

- seis roles con responsabilidades y contratos de salida;
- workflows para feature, bugfix, refactor y architecture;
- orquestación aislada con modos `full` y `light`;
- DevSession efímera como traspaso entre fases;
- SDD proporcional, TDD por comportamiento y diagnóstico falsable;
- historial durable mediante Engram;
- inteligencia de código primaria mediante CodeGraph;
- adapters nativos delgados para Codex y Claude Code.
- inicialización local, segura e idempotente con la biblioteca estándar de
  Node.js;
- validaciones automatizadas con `node:test` y directorios temporales.

No contiene un producto, rama ni layout de código predeterminados. El runtime de
Node.js se usa solo para el inicializador y sus tests. El comando no instala
herramientas, ejecuta agentes por su cuenta, sincroniza futuras versiones de la
plantilla ni gestiona publicación, paquetes, Git o remotos.

## Arquitectura

| Parte | Responsabilidad |
| --- | --- |
| Núcleo `.agents/` | Implementación canónica del proceso |
| Seam `AGENTS.md` | Interface configurable con hechos y restricciones del proyecto |
| `.codex/agents/` | Adapters nativos de los seis roles para Codex |
| `.claude/agents/` | Adapters nativos de los seis roles para Claude Code |
| `.claude/skills/orquestar/` | Wrapper de activación para Claude Code |
| `CLAUDE.md` | Import fijo del `AGENTS.md` raíz |
| `scripts/agentic-init.mjs` | Detección, copia segura, contrato y comprobaciones locales |
| `tests/agentic-init.test.mjs` | Especificación ejecutable de la interfaz CLI |

La interface es pequeña: un proyecto normal solo modifica `AGENTS.md`. El
comportamiento profundo queda localizado en `.agents/`. Codex es la primera
superficie de diseño y validación, pero ninguna garantía del núcleo depende de
una capacidad que Claude Code no pueda reproducir.

## Estructura

~~~text
.
├── README.md
├── .gitignore
├── AGENTS.md
├── CLAUDE.md
├── scripts/
│   └── agentic-init.mjs
├── tests/
│   └── agentic-init.test.mjs
├── .agents/
│   ├── README.md
│   ├── policies/
│   │   ├── orquestacion.md
│   │   └── sdd-tdd.md
│   ├── roles/
│   │   ├── explorador.md
│   │   ├── planificador.md
│   │   ├── implementador.md
│   │   ├── tester.md
│   │   ├── evaluador.md
│   │   └── documentador.md
│   ├── workflows/
│   │   ├── feature.md
│   │   ├── bugfix.md
│   │   ├── refactor.md
│   │   └── architecture.md
│   ├── skills/
│   │   ├── orquestar/SKILL.md
│   │   ├── agentic-grilling/SKILL.md
│   │   ├── agentic-tdd/SKILL.md
│   │   └── agentic-diagnostico-bugs/
│   │       ├── SKILL.md
│   │       └── references/hitl-loop.template.md
│   ├── templates/dev-session.md
│   └── sessions/.gitignore
├── .codex/agents/
│   ├── explorador.toml
│   ├── planificador.toml
│   ├── implementador.toml
│   ├── tester.toml
│   ├── evaluador.toml
│   └── documentador.toml
└── .claude/
    ├── .gitignore
    ├── agents/
    │   ├── explorador.md
    │   ├── planificador.md
    │   ├── implementador.md
    │   ├── tester.md
    │   ├── evaluador.md
    │   └── documentador.md
    └── skills/orquestar/SKILL.md
~~~

## Inicializador local

`scripts/agentic-init.mjs` usa únicamente la biblioteca estándar de Node.js y
toma el directorio actual como destino. También acepta una ruta posicional o
`--target <ruta>`.

El comando realiza estas operaciones en orden:

1. Detecta propósito, estructura, entrypoints, comandos, tests y documentación
   desde archivos como `package.json`, `pyproject.toml`, `Cargo.toml`,
   `README.md` y el árbol existente.
2. Si un dato contractual obligatorio sigue siendo desconocido, pregunta solo
   ese dato. En modo no interactivo indica la bandera necesaria: `--purpose` o
   `--git-strategy`.
3. Calcula todas las copias y colisiones antes de escribir. Un archivo distinto,
   un enlace simbólico o un ancestro no seguro detiene la ejecución sin
   sobrescribir contenido.
4. Copia o valida el inventario canónico de `.agents/`, `.codex/`, `.claude/` y
   `CLAUDE.md`.
5. Crea, completa o reemplaza solo el bloque delimitado
   `AGENTIC_PROJECT_CONTRACT` de `AGENTS.md`; conserva literalmente las
   instrucciones anteriores y posteriores.
6. Valida estructura, adapters, exclusiones efímeras, CodeGraph y Engram, y
   termina con `LISTO`, `ADVERTENCIAS` y `ACCIONES MANUALES PENDIENTES`.

~~~text
node scripts/agentic-init.mjs [destino]
node scripts/agentic-init.mjs --dry-run
node scripts/agentic-init.mjs --non-interactive --purpose "<propósito>" --git-strategy "<estrategia permitida>"
~~~

| Opción | Efecto |
| --- | --- |
| `--target <ruta>` | Selecciona un destino distinto del directorio actual |
| `--dry-run` | Muestra copias, validaciones y mutaciones opcionales sin escribir |
| `--non-interactive` | Falla con una lista accionable si falta un dato obligatorio |
| `--purpose <texto>` | Proporciona el propósito que no pudo descubrirse |
| `--git-strategy <texto>` | Declara la estrategia Git que no puede inferirse con seguridad |
| `--init-codegraph` | Confirma explícitamente `codegraph init` en el destino |
| `--update-codegraph` | Confirma explícitamente `codegraph sync` en el destino |

Sin una de las dos últimas banderas, CodeGraph se consulta con `status` y nunca
se modifica. De Engram se comprueba únicamente la disponibilidad del ejecutable
y su versión, sin leer ni escribir memorias; la identidad MCP del proyecto se
confirma manualmente desde el host de agentes. El inicializador no instala
ninguna herramienta y la disponibilidad real de los subagentes en cada host
sigue siendo una comprobación manual.

## Requisitos obligatorios

El proyecto consumidor debe disponer de:

1. **Node.js 20 o posterior** ya disponible para ejecutar el inicializador y
   sus pruebas, sin instalar paquetes.
2. **CodeGraph** instalado, con un índice vigente del repositorio y una consulta
   mínima funcional.
3. **Engram** disponible, capaz de identificar sin ambigüedad el proyecto actual
   y operar con memoria de ámbito de proyecto.
4. **Subagentes nativos** en la plataforma elegida.
5. **Contrato `AGENTS.md` completo** para todos los sectores afectados.

La instalación y configuración de estas herramientas ocurre fuera de este
repositorio. No copiar índices de CodeGraph ni memorias de Engram desde otro
proyecto. El artefacto distribuible no incluye un índice generado: hasta que el
propietario prepare CodeGraph para la copia local, el preflight se detendrá de
forma intencional.

La sintaxis de los adapters sigue la documentación vigente de
[subagentes de Codex](https://developers.openai.com/codex/multi-agent/) y
[subagentes de Claude Code](https://code.claude.com/docs/en/sub-agents).

## Preflight y fallo cerrado

Al comenzar una tarea orquestada, el orquestador comprueba una sola vez:

1. respuesta mínima de CodeGraph;
2. identidad inequívoca del proyecto en Engram;
3. capacidad de crear los subagentes requeridos;
4. completitud del contrato efectivo.

Si algo falla, la tarea se detiene con un diagnóstico breve. No hay fallback a
búsqueda manual, memoria informal, ejecución secuencial, procesos de agente por
CLI ni otra degradación silenciosa.

## Contrato de `AGENTS.md`

Copiar este bloque al `AGENTS.md` raíz y reemplazar todos los placeholders con
hechos reales. Usar `No aplica` cuando sea verdadero; no dejar campos vacíos.

~~~markdown
<!-- AGENTIC_PROJECT_CONTRACT_START -->

## Proyecto

- Propósito: <qué hace el proyecto>
- Arquitectura: <módulos y relaciones relevantes>
- Entrypoints: <interfaces o rutas de entrada>

## Validación

- Focalizada: <comando o procedimiento>
- Completa: <comando o procedimiento>

## Tests

- Framework: <framework o No aplica>
- Ubicación: <rutas o No aplica>
- Ciclo de vida: <cuándo crear, conservar y eliminar tests>

## Git

- Rama o estrategia permitida: <valor explícito>

## Seguridad

- Secretos: <mecanismos y prohibiciones>
- Rutas protegidas: <rutas o No aplica>
- Datos inmutables: <datos o No aplica>
- Acciones restringidas: <lista o No aplica>
- Contaminación de origen: <corpus reproducible o No aplica justificado>

## Documentación

- README y documentación técnica: <ubicaciones y criterio>
- ADRs: <ubicación y criterio o No aplica>

<!-- AGENTIC_PROJECT_CONTRACT_END -->
~~~

No añadir hechos del proyecto a roles, workflows, policies, skills,
`.codex/`, `.claude/` ni `CLAUDE.md`.

### Regla estricta

La regla que detiene una implementación con contrato incompleto está delimitada
en `.agents/policies/orquestacion.md` por
`STRICT_PROJECT_CONTRACT_RULE_START` y
`STRICT_PROJECT_CONTRACT_RULE_END`.

El propietario puede flexibilizarla editando ese bloque o eliminarla junto con
su referencia en el preflight. Hacerlo cambia una garantía de la capa y debe ser
una decisión consciente del proyecto.

## Modos de orquestación

| Modo | Activación | Profundidad |
| --- | --- | --- |
| `full` | Predeterminado; también automático para tareas no triviales | Workflow completo, SDD proporcional, TDD cuando corresponda y validación declarada |
| `light` | Solo por petición explícita | Mismos roles y DevSession; cambio y validación focalizados |

`Light` no selecciona modelo ni razonamiento. No crea tests, ejecuta la suite
completa, refactoriza ni amplía documentación por defecto. Si el impacto parece
considerable, el orquestador recomienda `full` y solicita una decisión
informada antes de continuar.

## Roles y workflows

Los roles canónicos son Explorador, Planificador, Implementador, Tester,
Evaluador y Documentador. Cada definición declara entradas, proceso, salida y
límites en `.agents/roles/`.

Los workflows están en `.agents/workflows/`:

- `feature`: explorar → planificar → implementar → testear → evaluar →
  documentar;
- `bugfix`: reproducir → diagnosticar → planificar → corregir → verificar →
  evaluar → documentar;
- `refactor`: explorar → definir invariantes → implementar → testear → evaluar
  → documentar;
- `architecture`: explorar → comparar → proponer decisión → aprobación del
  usuario → implementar con otro workflow → evaluar → documentar.

El Evaluador puede devolver trabajo al Implementador como máximo dos veces.

## Uso con Codex

1. Abrir el proyecto desde su raíz.
2. Comprobar que Codex cargó `AGENTS.md` y los agentes de
   `.codex/agents/*.toml`.
3. Pedir `orquestar <tarea>` para activación manual, o describir una tarea no
   trivial para la activación automática en `full`.
4. Para `light`, pedirlo de manera explícita.

Los TOML declaran solo nombre, descripción, restricciones de sandbox e
instrucciones para leer la definición canónica. No fijan modelo, nivel de
razonamiento ni MCP; esos valores se heredan de la sesión principal. No se
incluye `.codex/config.toml`: las versiones actuales descubren agentes
project-scoped en `.codex/agents/` y habilitan subagentes por defecto.

## Uso con Claude Code

1. Abrir el proyecto desde su raíz para que `CLAUDE.md` importe `AGENTS.md`.
2. Comprobar que los agentes de `.claude/agents/` y la skill `/orquestar`
   aparezcan disponibles.
3. Ejecutar `/orquestar <tarea>` o describir una tarea no trivial.
4. Solicitar explícitamente `light` cuando se desee validación reducida.

Los Markdown de `.claude/agents/` aplican allowlists o modo de solo lectura
cuando corresponde y remiten a `.agents/roles/`. El wrapper de
`.claude/skills/orquestar/` remite a la skill y política canónicas.
`CLAUDE.md` es fijo: no se usa como seam de configuración.

El Evaluador declara `permissionMode: plan` y no expone `Write` ni `Edit`, en
paridad con `sandbox_mode = "read-only"` de Codex. Claude Code permite que
ciertos modos más permisivos de la sesión padre prevalezcan sobre el modo del
subagente; por eso el host debe evitar `acceptEdits`, `auto` o
`bypassPermissions` cuando necesite aislamiento estricto del Evaluador.

## Integración en un proyecto nuevo

1. Pulsar **Use this template** y trabajar sobre la copia local resultante.
2. Ejecutar `node scripts/agentic-init.mjs` desde su raíz.

El resumen indica si la copia está lista y qué comprobaciones manuales faltan.
La copia es independiente desde ese momento; puede volver a ejecutar el mismo
comando sin duplicar el contrato ni modificar contenido correcto.

## Integración en un repositorio existente

1. Desde una copia confiable de esta plantilla, ejecutar primero
   `node scripts/agentic-init.mjs --target <repositorio> --dry-run`.
2. Revisar el plan y resolver manualmente cualquier colisión informada.
3. Repetir sin `--dry-run`. Los archivos ausentes se copian, los idénticos se
   validan y los distintos nunca se sobrescriben.
4. Revisar el bloque generado de `AGENTS.md`; cualquier instrucción existente
   fuera de sus marcadores se conserva.
5. Ejecutar las acciones manuales pendientes del resumen en el host elegido.

El inicializador no copia este `README.md` sobre el README del producto. Tampoco
crea un vínculo posterior, consulta un upstream ni actualiza la plantilla desde
remotos.

## Monorepos y `AGENTS.md` anidados

El archivo raíz conserva seguridad, herramientas y orquestación. Un
`AGENTS.md` local puede redefinir para su sector Proyecto, Validación, Tests y
Documentación; una regla local nunca debilita silenciosamente una restricción
global.

El Explorador recorre explícitamente la cadena raíz → sector. Si una tarea cruza
dos sectores, registra ambas cadenas, acumula validaciones compatibles y
devuelve al orquestador cualquier contradicción irreconciliable.

## DevSession y estado efímero

Cada tarea usa `.agents/sessions/<slug>.md`, creado desde
`.agents/templates/dev-session.md`. El mismo formato sirve para `full` y
`light`; los campos no pertinentes usan `No aplica`.

La DevSession conserva el estado exacto de la tarea y se elimina al cerrar
correctamente. `.agents/sessions/.gitignore` impide versionar instancias reales.
No reemplazarla con Engram ni guardar su contenido completo como memoria.

## Política de Engram

- Usar ámbito de proyecto por defecto.
- Consultar con preguntas concretas; no cargar historial amplio.
- Guardar solo decisiones, incidentes y soluciones validados, no obvios,
  reutilizables y accionables.
- Permitir que Engram deduplique y relacione recuerdos.
- No guardar logs, hipótesis descartadas, auditorías no confirmadas ni estado
  transitorio.
- Solicitar autorización explícita antes de usar ámbito personal o global.

## Validación de la capa

Realizar la validación con herramientas ya disponibles; no instalar
dependencias solo para estos checks.

~~~text
node --check scripts/agentic-init.mjs
node --test tests/agentic-init.test.mjs
node scripts/agentic-init.mjs --dry-run --non-interactive
~~~

La suite crea y elimina sus propios directorios temporales. Cubre repositorio
nuevo, `AGENTS.md` existente, contrato parcial, colisiones sin escrituras,
repetición idempotente, `--dry-run`, herramientas externas ausentes, copia base
de GitHub, confirmación de CodeGraph, adapters, detección no-Node y destino
actual, además de una adopción integral con vista previa, aplicación y segunda
ejecución estable.

### Integridad estructural

1. Comprobar que todos los archivos del árbol existan.
2. Resolver todos los enlaces Markdown internos.
3. Confirmar que cada workflow referencia roles existentes.
4. Confirmar que cada rol contiene Entradas, Proceso, Salida y Límites.
5. Parsear los TOML y el frontmatter YAML.
6. Confirmar que cada adapter apunta a rutas canónicas existentes y no duplica
   cuerpos completos.
7. Confirmar todos los campos de DevSession.
8. Confirmar que sesiones y configuraciones personales quedan ignoradas.

El inicializador ejecuta este control antes de copiar. En particular, exige que
`.agents/sessions/` contenga solo `.gitignore`, que los doce adapters apunten a
roles canónicos y que el Evaluador conserve aislamiento de solo lectura.

### Ausencia de contaminación

El campo `Contaminación de origen` del contrato es obligatorio y admite solo dos
estados:

1. `No aplica: <justificación>` cuando el proyecto adopta esta fuente canónica
   y no se extrajo una capa desde otro repositorio.
2. `Corpus: <ruta o identificador del artefacto>` cuando existe un repositorio
   de origen. Ese corpus reproducible debe enumerar, como literales UTF-8, sus
   nombres, módulos, dominios, proveedores, formatos, rutas, comandos, fechas,
   identificadores y rutas absolutas características.

En el segundo caso, escanear todos los archivos de distribución y repetir el
scan limitado a `.agents/`, excluyendo el propio corpus y directorios generados
o personales. Registrar el corpus, el alcance, el procedimiento y el resultado;
cualquier coincidencia no permitida bloquea la aprobación. No aceptar un scan
sin corpus ni convertir un origen desconocido en `No aplica`.

CodeGraph, Engram, Codex y Claude Code son las únicas herramientas nombradas
deliberadamente como requisitos universales.

### Simulaciones en seco

Recorrer roles, reportes y DevSession sin modificar un producto real:

1. feature no trivial que active `full` automáticamente;
2. cambio de texto solicitado en `light`, sin tests nuevos;
3. cambio visual en `light` con inspección o renderizado;
4. petición `light` de impacto considerable que exija confirmación;
5. bugfix `full` con reproducción, diagnóstico y regresión;
6. decisión arquitectónica con aprobación explícita;
7. tarea que cruce dos sectores con `AGENTS.md` anidados;
8. preflight sin uno de los requisitos, que debe detenerse.

Cada simulación debe poder completarse sin asumir lenguaje, framework, rama,
dominio ni una ruta no declarada.

## Inicialización local y responsabilidad

Esta capa se adopta mediante una copia inicial. Deliberadamente no incluye:

- instalación de herramientas o dependencias;
- gestor de versiones;
- remoto upstream;
- submodule o subtree;
- paquete;
- sincronización o actualización automática.

`agentic-init.mjs` configura únicamente la copia local y puede revalidarla de
forma idempotente; no es un gestor de distribución. Después de adoptarla, el
propietario es responsable de mantenerla, resolver colisiones, validar nuevas
versiones de las plataformas, decidir la estrategia Git y añadir una licencia
antes de publicar si corresponde.
