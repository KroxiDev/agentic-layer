---
name: orquestar
description: Orquesta tareas de desarrollo mediante roles aislados, DevSession y workflows full o light. Usar cuando el usuario pida orquestar o cuando la política canónica clasifique una señal cerrada de full automático; light requiere petición explícita.
---

# Orquestar

<!-- agentic-protocol:v2 -->

1. Leer `AGENTS.md` y la
   [política de orquestación](../../policies/orquestacion.md); aplicar allí la
   decisión de activación y el preflight.
2. Seleccionar y leer el [workflow](../../workflows/) correspondiente. Resolver
   modo, fases y excepciones solo desde esos contratos canónicos. Usar
   `agentic-light-sequence:v2` para una sesión compacta nueva; su equivalente
   `v1` se consulta solo al terminar una sesión legacy.
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
   y materializar un `WorkEnvelope` inmutable con objetivo, reglas, tareas,
   findings, manifiesto de `contextPaths` y hash de aceptación. Despachar solo el
   sobre y la instrucción breve de ejecutar el contrato del rol. Para una sesión
   v1 activa, el alias compatible de ese sobre es la SubDevSession vigente.
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

Una sesión v1 activa puede terminar con el
[controller de compatibilidad](../../scripts/session-controller.mjs) o migrarse
explícitamente en un checkpoint sin writers ni reportes pendientes. Nunca usar
ese controller para iniciar una sesión V2 ni migrar una sesión activa por
inferencia.

En `architecture`, terminar después de registrar la decisión aprobada cuando no
haya implementación. Si debe implementarse, cerrar ese workflow y transferir la
decisión una sola vez a `feature` o `refactor`; no volver a evaluar ni documentar
en `architecture` lo que el workflow posterior ya cerró.

No añadir `lightStrategy` a una DevSession existente que no lo tenga: su
ausencia identifica la secuencia legacy.

No ejecutar roles secuencialmente en el hilo del orquestador ni sustituir
subagentes con procesos de CLI.
