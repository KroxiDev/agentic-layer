# Workflow: refactor

Usar para reestructurar una implementación sin cambiar su comportamiento
observable.

1. **Explorar — Explorador:** <!-- agentic-phase:v1 {"id":"refactor-explore","role":"explorador"} --> delimitar sector, dependientes, seams y reglas
   efectivas.
2. **Definir invariantes — Planificador:** <!-- agentic-phase:v1 {"id":"refactor-plan","role":"planificador"} --> enumerar lo que no debe cambiar y la
   evidencia que lo protege.
3. **Implementar — Implementador:** <!-- agentic-phase:v1 {"id":"refactor-implement","role":"implementador"} --> cambiar en pasos pequeños dentro del sector
   aprobado.
4. **Testear — Tester:** <!-- agentic-phase:v1 {"id":"refactor-test","role":"tester"} --> comprobar invariantes con la validación declarada.
5. **Evaluar — Evaluador:** <!-- agentic-phase:v1 {"id":"refactor-evaluate","role":"evaluador"} --> verificar ausencia de regresiones y una mejora real
   de profundidad, leverage o localidad, sin abstracción gratuita.
6. **Documentar — Documentador:** <!-- agentic-phase:v1 {"id":"refactor-document","role":"documentador"} --> actuar solo si la reestructura cambia
   interfaces o documentación vigente.

En `light` no introducir seams ni abstracciones nuevas salvo que sean el objeto
explícito aprobado.
