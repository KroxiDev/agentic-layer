# Workflow: feature

Usar para funcionalidades nuevas o cambios de comportamiento observables.

1. **Explorar — Explorador:** <!-- agentic-phase:v1 {"id":"feature-explore","role":"explorador"} --> delimitar sector, dependencias y reglas efectivas.
2. **Planificar — Planificador:** <!-- agentic-phase:v1 {"id":"feature-plan","role":"planificador"} --> producir especificación, seams, tareas y
   evidencia; activar grilling si hay decisiones ambiguas.
3. **Implementar — Implementador:** <!-- agentic-phase:v1 {"id":"feature-implement","role":"implementador"} --> ejecutar el cambio mínimo; en `full`, usar
   TDD donde la especificación lo marque.
4. **Testear — Tester:** <!-- agentic-phase:v1 {"id":"feature-test","role":"tester"} --> verificar criterios y registrar evidencia exacta.
5. **Evaluar — Evaluador:** <!-- agentic-phase:v1 {"id":"feature-evaluate","role":"evaluador"} --> aprobar o devolver cambios concretos; máximo dos
   ciclos hacia Implementador.
6. **Documentar — Documentador:** <!-- agentic-phase:v1 {"id":"feature-document","role":"documentador"} --> actualizar solo lo que el cambio vuelva
   incorrecto y consolidar memoria durable.

En `light` se conserva la secuencia completa, con implementación y testing
reducidos según la política de orquestación.
