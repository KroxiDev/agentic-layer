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

El Planificador puede definir entre una y tres unidades de implementación con
dependencias y ownership exclusivo. El orquestador ejecuta Implementador y
Tester por unidad, habilita dependencias solo después de validación atribuible y
realiza fan-in cuando todas quedan consolidadas. En `light`, un Evaluador cubre
Estándares y Especificación; en `full`, dos Evaluadores de solo lectura cubren
esos ejes independientemente.

Un Tester rojo o fallido reabre retrabajo sin validar. Cada nuevo fan-in
invalida la generación anterior y exige reevaluar sus ejes.
