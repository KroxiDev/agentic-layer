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
3. Conducir el kernel con el CLI delgado
   [`kernel-cli.mjs`](../../scripts/kernel-cli.mjs):
   `node .agents/scripts/kernel-cli.mjs apply start-session …` crea la sesión,
   `inspect <sessionId>` lee la vista, `apply <tipo> …` muta con `commandId` y
   revisión esperada, y `help <tipo>` imprime las claves exactas del payload
   sin leer el kernel. El CLI es un adapter de la composición productiva
   [`createOrchestrationComposition`](../../kernel/composition.mjs): tras un
   reinicio recupera autoridad repitiendo exactamente el `start-session`
   persistido en el snapshot y nunca imprime la capacidad opaca. No escribir
   composición inline ni reconstruir manualmente los adapters del
   `OrchestrationKernel`; conservar la capacidad emitida fuera de sobres,
   prompts y reportes.
4. Pedir al Planificador el plan exigido por la política, aceptar su
   `AcceptanceContract` versionado y despachar únicamente fases y unidades
   listas. En compacto, exigir una sola unidad y su validación focalizada antes
   de abrir implementación.
5. Antes de cada `dispatch-attempt`, aplicar la selección mínima de la política
   y construir el payload con las claves exactas que imprime
   `node .agents/scripts/kernel-cli.mjs help dispatch-attempt`. El kernel
   materializa un `WorkEnvelope` inmutable y autocontenido y deriva
   `sourceRevision` y `contextPaths`. Despachar solo el sobre y la instrucción
   breve de ejecutar el contrato del rol; nunca una capacidad o el ledger. El
   prompt del subagente es la salida de
   `node .agents/scripts/kernel-cli.mjs brief <sessionId> <attemptId>`, que ya
   incluye el sobre, el contrato del rol y el contrato del reporte: el
   subagente no relee roles, políticas ni esquemas.
6. Recibir un `RoleReport` estructurado y presentarlo al kernel con
   `accept-role-report`. Los roles nunca reciben capacidad ni mutan estado. Usar
   `record-attempt-failure` para cerrar interrupciones sin fabricar reportes, y
   `record-user-input`, `record-validation`, `amend-scope` y
   `resolve-scope-decision` únicamente en sus estados admitidos.
   Un reporte `context_insufficient` no consume retrabajo: re-despachar la
   misma misión al mismo rol con el manifiesto ampliado con las rutas de
   `missingContext`.
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
