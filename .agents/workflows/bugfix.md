# Workflow: bugfix

Usar para bugs, fallos y regresiones. La disciplina canónica es
`.agents/skills/agentic-diagnostico-bugs/SKILL.md`.

1. **Reproducir — Tester:** construir un bucle rojo-capaz, ejecutar la
   reproducción y minimizarla. Si no existe una señal válida, detenerse y
   devolver lo intentado.
2. **Diagnosticar — Explorador:** usar CodeGraph y la evidencia para producir
   hipótesis falsables rankeadas y delimitar el sector. El orquestador presenta
   las hipótesis al usuario antes de las sondas.
3. **Planificar — Planificador:** especificar el comportamiento correcto, la
   causa respaldada, el seam de regresión y el cambio mínimo.
4. **Corregir — Implementador:** instrumentar una variable por vez si hace
   falta, escribir el test de regresión antes del fix cuando exista un seam
   correcto y aplicar la corrección.
5. **Verificar — Tester:** ejecutar la reproducción original, el test de
   regresión y las validaciones exigidas.
6. **Evaluar — Evaluador:** aprobar o devolver cambios concretos; máximo dos
   ciclos hacia Implementador.
7. **Documentar — Documentador:** registrar solo conocimiento durable y
   documentación afectada.

En `light` se conserva la secuencia. La reducción de evidencia nunca permite
hipotetizar sin un bucle rojo-capaz ni omitir una regresión necesaria para
demostrar el arreglo.
