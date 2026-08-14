# Workflow: bugfix

Usar para bugs, fallos y regresiones. La disciplina canónica es
`.agents/skills/agentic-diagnostico-bugs/SKILL.md`.

1. **Reproducir — Tester:** <!-- agentic-phase:v1 {"id":"bugfix-reproduce","role":"tester"} --> construir un bucle rojo-capaz, ejecutar la
   reproducción y minimizarla. Si no existe una señal válida, detenerse y
   devolver lo intentado.
2. **Diagnosticar — Explorador:** <!-- agentic-phase:v1 {"id":"bugfix-diagnose","role":"explorador"} --> usar CodeGraph y la evidencia para aplicar la
   clasificación de `.agents/skills/agentic-diagnostico-bugs/SKILL.md`, explicar
   la causa o las hipótesis respaldadas y delimitar el sector. Devolver al
   orquestador únicamente los checkpoints o bloqueos que esa clasificación
   requiera.
3. **Planificar — Planificador:** <!-- agentic-phase:v1 {"id":"bugfix-plan","role":"planificador"} --> especificar el comportamiento correcto, la
   causa respaldada, el seam de regresión y el cambio mínimo.
4. **Corregir — Implementador:** <!-- agentic-phase:v1 {"id":"bugfix-implement","role":"implementador"} --> instrumentar una variable por vez si hace
   falta, escribir el test de regresión antes del fix cuando exista un seam
   correcto y aplicar la corrección.
5. **Verificar — Tester:** <!-- agentic-phase:v1 {"id":"bugfix-test","role":"tester"} --> ejecutar la reproducción original, el test de
   regresión y las validaciones exigidas.
6. **Evaluar — Evaluador:** <!-- agentic-phase:v1 {"id":"bugfix-evaluate","role":"evaluador"} --> aprobar o devolver cambios concretos; máximo dos
   ciclos hacia Implementador.
7. **Documentar — Documentador (condicional):** <!-- agentic-phase:v1 {"id":"bugfix-document","role":"documentador"} --> abrir únicamente cuando el gate de la
   política de orquestación detecte documentación o memoria durable pendiente.

En `light` se conserva la secuencia y se justifica brevemente cualquier mecánica
omitida porque no aumentaría la información. La reducción de evidencia nunca
permite hipotetizar sin un bucle rojo-capaz o evidencia equivalente ni omitir
una regresión necesaria para demostrar el arreglo.

Un bugfix conserva normalmente una sola unidad de implementación. Si el plan
demuestra unidades independientes, respetar sus dependencias, ownership y
validación focalizada inmediata sin superar tres. Ejecutar fan-in tras
consolidarlas; en `full`, ejecutar la validación completa una sola vez después
del fan-in. Evaluar Estándares y Especificación con un Evaluador combinado por
defecto, o con dos Evaluadores independientes solo cuando el plan haya
registrado antes del fan-in una estrategia dual y un `evaluationRisk` admitido.

Un Tester rojo o fallido reabre retrabajo sin validar. Cada nuevo fan-in
invalida la generación anterior y exige reevaluar sus ejes.

La validación por unidad y la fase Documentador aplican los gates canónicos de
la política de orquestación; los roles no reinterpretan sus excepciones.
