---
name: orquestar
description: Orquesta tareas de desarrollo mediante roles aislados, DevSession y workflows full o light. Usar cuando el usuario pida orquestar o cuando la política canónica clasifique una señal cerrada de full automático; light requiere petición explícita.
---

# Orquestar

1. Leer `AGENTS.md` y la
   [política de orquestación](../../policies/orquestacion.md); aplicar allí la
   decisión de activación y el preflight.
2. Seleccionar y leer el [workflow](../../workflows/) correspondiente. Resolver
   modo, fases y excepciones solo desde esos contratos canónicos. Para una
   sesión `lightStrategy: "compact"`, usar exclusivamente
   `agentic-light-sequence:v1`; no inferir fases desde la prosa.
3. Crear o adoptar la DevSession y administrar estado y sobres con el
   [controlador](../../scripts/session-controller.mjs), siempre con la revisión
   esperada.
4. Pedir al Planificador el plan exigido por la política, registrarlo con
   `init` y despachar únicamente fases y unidades listas a los roles indicados
   por los marcadores del workflow. En compacto, exigir una sola unidad y su
   validación focalizada antes de abrir implementación.
5. Usar `open`, `await-input`, `resume`, `commit` y `fail` para mantener cada
   intento atribuible; cerrar su hilo cuando el resultado ya esté consolidado.
6. Aplicar desde la política los gates de validación, integración, evaluación y
   documentación, pasando a cada rol solo los sobres pertinentes del índice. La
   aprobación del Evaluador combinado consolida la única unidad compacta; la
   ruta separada conserva el Tester por unidad.
7. Consolidar conocimiento durable en Engram y ejecutar `cleanup` y `close`
   únicamente cuando se satisfagan las precondiciones canónicas.

En `architecture`, terminar después de registrar la decisión aprobada cuando no
haya implementación. Si debe implementarse, cerrar ese workflow y transferir la
decisión una sola vez a `feature` o `refactor`; no volver a evaluar ni documentar
en `architecture` lo que el workflow posterior ya cerró.

No añadir `lightStrategy` a una DevSession existente que no lo tenga: su
ausencia identifica la secuencia legacy.

No ejecutar roles secuencialmente en el hilo del orquestador ni sustituir
subagentes con procesos de CLI.
