# Workflow: feature

Usar para funcionalidades nuevas o cambios de comportamiento observables.

1. **Explorar — Explorador:** delimitar sector, dependencias y reglas efectivas.
2. **Planificar — Planificador:** producir especificación, seams, tareas y
   evidencia; activar grilling si hay decisiones ambiguas.
3. **Implementar — Implementador:** ejecutar el cambio mínimo; en `full`, usar
   TDD donde la especificación lo marque.
4. **Testear — Tester:** verificar criterios y registrar evidencia exacta.
5. **Evaluar — Evaluador:** aprobar o devolver cambios concretos; máximo dos
   ciclos hacia Implementador.
6. **Documentar — Documentador:** actualizar solo lo que el cambio vuelva
   incorrecto y consolidar memoria durable.

En `light` se conserva la secuencia completa, con implementación y testing
reducidos según la política de orquestación.
