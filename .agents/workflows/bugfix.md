# Workflow: bugfix

<!-- agentic-workflow -->

Usar para bugs, fallos y regresiones. La disciplina canónica es
`.agents/skills/agentic-diagnostico-bugs/SKILL.md`.
Las mecánicas comunes de modo, unidades, validación, evaluación y cierre
pertenecen a la [política de orquestación](../policies/orquestacion.md); este
archivo fija únicamente el orden y la intención de las fases de `bugfix`.

<!-- agentic-light-sequence {"phases":["bugfix-reproduce","bugfix-plan","bugfix-implement","bugfix-evaluate"]} -->

1. **Reproducir — Tester:** <!-- agentic-phase {"id":"bugfix-reproduce","role":"tester"} --> construir un bucle rojo-capaz, ejecutar la
   reproducción y minimizarla. Si no existe una señal válida, detenerse y
   devolver lo intentado.
2. **Diagnosticar — Explorador:** <!-- agentic-phase {"id":"bugfix-diagnose","role":"explorador"} --> usar CodeGraph y la evidencia para aplicar la
   clasificación de `.agents/skills/agentic-diagnostico-bugs/SKILL.md`, explicar
   la causa o las hipótesis respaldadas y delimitar el sector. Devolver al
   orquestador únicamente los checkpoints o bloqueos que esa clasificación
   requiera.
3. **Planificar — Planificador:** <!-- agentic-phase {"id":"bugfix-plan","role":"planificador"} --> especificar el comportamiento correcto, la
   causa respaldada, el seam de regresión y el cambio mínimo.
4. **Corregir — Implementador:** <!-- agentic-phase {"id":"bugfix-implement","role":"implementador"} --> instrumentar una variable por vez si hace
   falta, escribir el test de regresión antes del fix cuando exista un seam
   correcto y aplicar la corrección.
5. **Verificar — Tester:** <!-- agentic-phase {"id":"bugfix-test","role":"tester"} --> ejecutar la reproducción original, el test de
   regresión y las validaciones exigidas.
6. **Evaluar — Evaluador:** <!-- agentic-phase {"id":"bugfix-evaluate","role":"evaluador"} --> aprobar o devolver cambios concretos; máximo dos
   ciclos hacia Implementador.
7. **Documentar — Documentador (condicional):** <!-- agentic-phase {"id":"bugfix-document","role":"documentador"} --> ejecutar solo cuando el gate canónico
   autorice trabajo documental o de memoria durable.

En `light` compacto, el marcador estructural anterior sustituye la secuencia
general para bugs deterministas: conserva la reproducción previa, el
Planificador absorbe el diagnóstico mínimo y el Evaluador combinado realiza la
validación independiente. La reducción de evidencia nunca permite hipotetizar
sin un bucle rojo-capaz o evidencia equivalente ni omitir una regresión
necesaria para demostrar el arreglo.

Un bugfix conserva normalmente una sola unidad de implementación. Dividirlo
solo cuando el diagnóstico demuestre unidades independientes; su contrato y sus
gates son los definidos por la política canónica. Cada fase devuelve un
`RoleReport` y solo el orquestador lo entrega a
`OrchestrationKernel.apply`.
