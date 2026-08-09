# Capa agéntica reusable

Contexto único del repositorio: un proceso de desarrollo asistido por agentes que
se adopta como copia en cualquier proyecto. El dominio no es el software del
proyecto adoptante, sino el proceso que lo desarrolla y el mecanismo que lo
instala.

Este archivo es el glosario del proyecto y nada más. No se distribuye con la
capa: sirve al mantenimiento de esta plantilla. La estructura detallada vive en
[docs/arquitectura.md](docs/arquitectura.md) y las decisiones en
[docs/adr/](docs/adr/).

## Lenguaje

### El proceso

**Capa agéntica**:
El conjunto instalado que define cómo se desarrolla en un proyecto: núcleo,
adapters y contrato. Es lo que se adopta, se versiona y se reemplaza.
_Evitar_: framework, sistema, engine.

**Plantilla**:
Este repositorio en su papel de fuente canónica de la capa. Una plantilla no se
orquesta a sí misma; produce copias.
_Evitar_: upstream, master, repo padre.

**Núcleo**:
`.agents/`, la única implementación del proceso. Ningún proyecto adoptante lo
edita.
_Evitar_: core, motor, librería.

**Orquestador**:
El único interlocutor del usuario durante una tarea. Selecciona workflow y modo,
mantiene la DevSession y delega cada fase.
_Evitar_: coordinador, manager, agente principal.

**Rol**:
Una responsabilidad acotada con entradas, proceso, salida y límites declarados,
ejecutada en un contexto aislado. Son seis: Explorador, Planificador,
Implementador, Tester, Evaluador, Documentador.
_Evitar_: agente, persona, actor.

**Workflow**:
La secuencia de fases que aplica a una intención: `feature`, `bugfix`,
`refactor`, `architecture`.
_Evitar_: pipeline, proceso, receta.

**Fase**:
Un tramo del workflow ejecutado por un solo rol en un contexto aislado, que
termina devolviendo su contrato de salida.
_Evitar_: paso, etapa, iteración.

**Modo de orquestación**:
La profundidad con la que se ejecuta un workflow: `full` o `light`. Es
intensidad de implementación y verificación, nunca elección de modelo ni de
nivel de razonamiento.
_Evitar_: modo (a secas), nivel, perfil de ejecución.

**DevSession**:
El estado efímero de una tarea en `.agents/sessions/<slug>.md`, único traspaso
entre fases. Se elimina al cerrar y no se versiona.
_Evitar_: sesión, contexto compartido, scratchpad, memoria de trabajo.

**Sector de importancia**:
El conjunto mínimo suficiente de archivos, símbolos y superficies que una tarea
puede tocar, delimitado por el Explorador.
_Evitar_: alcance, área, scope, blast radius.

**Preflight**:
La comprobación única que precede a toda tarea orquestada: CodeGraph, Engram,
subagentes y contrato completo. La fase equivalente del inicializador se llama
plan, no preflight.
_Evitar_: precheck, arranque, bootstrap.

**Fallo cerrado**:
Detenerse ante un requisito ausente en lugar de degradar a una alternativa
peor. No hay fallback a grep, memoria improvisada ni ejecución secuencial.
_Evitar_: fail-safe, modo degradado, graceful degradation.

### El contrato

**Contrato de proyecto**:
El bloque delimitado por `AGENTIC_PROJECT_CONTRACT_START` y `..._END` dentro de
`AGENTS.md`: los hechos y restricciones que la capa necesita de este proyecto.
_Evitar_: configuración, manifiesto, settings.

**Contrato de salida**:
El formato exacto que un rol devuelve al orquestador y nada más. Homónimo del
anterior sólo por convención; nunca usar «el contrato» sin calificar cuando
ambos estén en juego.
_Evitar_: reporte, respuesta, output.

**Seam**:
Un límite público donde el comportamiento se observa sin acceder al interior.
Los tests viven en seams. El seam de configuración de la capa es `AGENTS.md`.
_Evitar_: punto de extensión, hook, boundary.

**Campo pendiente**:
Un campo del contrato que el inicializador no pudo inferir y escribió como
`<pendiente: …>`. Cuenta como contrato incompleto y detiene la orquestación
hasta que alguien lo decida.
_Evitar_: hueco, gap, TODO, valor por defecto.

**Contaminación de origen**:
Rastros de un repositorio ajeno en una capa extraída de él. El contrato exige
declararla como corpus reproducible de marcadores o como `No aplica`
justificado.
_Evitar_: fuga, leak, residuo (que significa otra cosa aquí).

### La adopción

**Adopción**:
Copiar la capa a un proyecto y generar su contrato con un solo comando. Es una
copia sin vínculo posterior: no crea dependencia ni sincronización.
_Evitar_: instalación, integración, setup, bootstrap.

**Inicializador**:
`scripts/agentic-init.mjs`, la única implementación de la adopción. Detecta,
planifica, copia y genera el contrato; no instala herramientas ni toca Git.
_Evitar_: script, generador, scaffolder.

**Distribución**:
El artefacto npm publicable que transporta la capa.
_Evitar_: build, release, bundle.

**Inventario canónico**:
La lista exacta de rutas que la distribución transporta, declarada en el código
y verificada contra `package.json`. Lo que no está en el inventario no puede
publicarse.
_Evitar_: file list, contenido, whitelist.

**Asset de distribución**:
Un archivo del inventario que viaja con un nombre neutro porque npm no puede
transportar el canónico, y que el inicializador restaura al copiarlo.
_Evitar_: recurso, blob, archivo especial.

**Plan**:
El cálculo completo de copias, colisiones y residuos previo a cualquier
escritura. Toda condición bloqueante detiene la ejecución con el disco intacto.
_Evitar_: preflight (reservado a la orquestación), dry run (que es una bandera,
no la fase).

**Colisión**:
Una ruta del inventario ocupada por algo que la capa no puede reemplazar por sí
sola: un archivo ajeno, un enlace simbólico, un directorio o un ancestro no
seguro. Detiene la ejecución.
_Evitar_: conflicto, choque.

**Divergencia**:
Un archivo canónico presente pero con contenido distinto del distribuido. Sobre
una capa instalada se resuelve como reemplazo de versión; sin capa instalada es
una colisión.
_Evitar_: modificación local, drift.

**Residuo**:
Un archivo que sobrevive dentro de un directorio gestionado sin pertenecer al
inventario canónico: sobra de otra versión de la capa. El reemplazo lo elimina.
_Evitar_: basura, huérfano, sobra.

**Directorio gestionado**:
Un directorio cuyo contenido pertenece por completo a la capa, y donde por tanto
todo archivo ajeno al inventario es un residuo. `.agents/sessions/` y la raíz de
`.agents/` quedan fuera deliberadamente.
_Evitar_: carpeta controlada, owned directory.

**Marcador de capa**:
Un archivo cuya sola presencia prueba que el destino ya adoptó la capa, y que
convierte una divergencia en reemplazo de versión en lugar de colisión.
_Evitar_: sentinel, flag, huella.

**Perfil de ecosistema**:
El conjunto de valores recomendados de validación, tests y documentación que se
deducen del ecosistema detectado (Node, Python, Rust, Go) para reducir los
campos pendientes.
_Evitar_: preset, plantilla de lenguaje, default.

**Integridad estructural**:
La comprobación que la propia capa hace de sí misma antes de copiar: inventario,
enlaces, roles, adapters, DevSession y manifiesto. No es la validación del
proyecto adoptante.
_Evitar_: validación de la capa, lint, self-test.

**Validación**:
La evidencia que el proyecto adoptante exige para aceptar un cambio, declarada
en su contrato como focalizada y completa. Siempre es del proyecto, nunca de la
capa.
_Evitar_: verificación, QA, checks.
