---
name: orquestar
description: Orquesta tareas de desarrollo mediante roles aislados, DevSession y workflows full o light. Usar cuando el usuario pida orquestar o cuando la política canónica clasifique una señal cerrada de full automático; light requiere petición explícita.
---

# Orquestar

<!-- agentic-protocol -->

1. Leer `AGENTS.md` y la
   [política de orquestación](../../policies/orquestacion.md); aplicar allí la
   decisión de activación y el preflight.
2. Seleccionar y leer el [workflow](../../workflows/) correspondiente. Resolver
   modo, fases y excepciones solo desde esos contratos canónicos. Usar
   `agentic-light-sequence` para una sesión `light`, siempre compacta y con una
   sola unidad.
3. Para una sesión nueva, crear una instancia del
   [`OrchestrationKernel`](../../kernel/orchestration-kernel.mjs), ejecutar
   `start-session` con la capacidad bootstrap y conservar la capacidad opaca
   emitida fuera de sobres, prompts y reportes. Usar `inspect` para leer y
   `apply` con `commandId` y revisión esperada para toda mutación.
4. Pedir al Planificador el plan exigido por la política, aceptar su
   `AcceptanceContract` versionado y despachar únicamente fases y unidades
   listas. En compacto, exigir una sola unidad y su validación focalizada antes
   de abrir implementación.
5. Antes de cada `dispatch-attempt`, aplicar la selección mínima de la política
   y declarar rol, `permission`, `baseRevision`, `threadId`, fase, objetivo,
   reglas, tareas, `findings` y `contextManifest`. El kernel materializa un
   `WorkEnvelope` inmutable con hash y tipo de contrato, identidades, versión,
   generación, `sourceRevision`, criterios completos, `ownedPaths`,
   `validationStrategy`, `wave` y `contextPaths`. Despachar solo el sobre y la
   instrucción breve de ejecutar el contrato del rol; nunca una capacidad o el
   ledger.
6. Recibir un `RoleReport` estructurado y presentarlo al kernel con
   `accept-role-report`. Los roles nunca reciben capacidad ni mutan estado. Usar
   `record-attempt-failure` para cerrar interrupciones sin fabricar reportes, y
   `record-user-input`, `record-validation`, `amend-scope` y
   `resolve-scope-decision` únicamente en sus estados admitidos.
7. Aplicar desde la política los gates de unidad, lane `full:<generation>`,
   evaluación, decisión de alcance y documentación. No inferir veredictos desde
   `humanSummary` ni convertir un finding nuevo en retrabajo automático.
8. Consolidar conocimiento durable en Engram y ejecutar `close-session`
   únicamente cuando se satisfagan las precondiciones canónicas.

Si el usuario o un handoff aporta rutas explícitas de una tarea anterior, leer
esas fuentes como evidencia ordinaria. Extraer objetivo, decisiones confirmadas,
restricciones, trabajo verificable, validaciones vigentes y pendientes;
contrastarlos con repositorio, diff y pruebas, e iniciar una sesión normal sin
heredar estado ni añadir campos o comandos al kernel. Registrar fuera del
kernel las rutas exactas del bundle: eliminarlo solo tras éxito completo,
validando que cada destino resuelto pertenece al repositorio y al ownership de
esa sesión, sin globs. Verificar la ausencia e informar lo eliminado; ante
fallo, bloqueo, ambigüedad o trabajo incompleto, conservar el bundle.

En `architecture`, terminar después de registrar la decisión aprobada cuando no
haya implementación. Si debe implementarse, cerrar ese workflow y transferir la
decisión una sola vez a `feature` o `refactor`; no volver a evaluar ni documentar
en `architecture` lo que el workflow posterior ya cerró.

No ejecutar roles secuencialmente en el hilo del orquestador ni sustituir
subagentes con procesos de CLI.
