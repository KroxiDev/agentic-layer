# Workflow: feature

<!-- agentic-workflow -->

Usar para funcionalidades nuevas o cambios de comportamiento observables.
Las mecánicas comunes de modo, unidades, validación, evaluación y cierre
pertenecen a la [política de orquestación](../policies/orquestacion.md); este
archivo fija únicamente el orden y la intención de las fases de `feature`.

<!-- agentic-light-sequence {"phases":["feature-plan","feature-implement","feature-evaluate"]} -->

1. **Explorar — Explorador:** <!-- agentic-phase {"id":"feature-explore","role":"explorador"} --> delimitar sector, dependencias y reglas efectivas.
2. **Planificar — Planificador:** <!-- agentic-phase {"id":"feature-plan","role":"planificador"} --> producir especificación, seams, tareas y
   evidencia; activar grilling si hay decisiones ambiguas.
3. **Implementar — Implementador:** <!-- agentic-phase {"id":"feature-implement","role":"implementador"} --> ejecutar el cambio mínimo según la
   especificación y la política canónica.
4. **Testear — Tester:** <!-- agentic-phase {"id":"feature-test","role":"tester"} --> verificar criterios y registrar evidencia exacta.
5. **Evaluar — Evaluador:** <!-- agentic-phase {"id":"feature-evaluate","role":"evaluador"} --> aprobar o devolver cambios concretos; máximo dos
   ciclos hacia Implementador.
6. **Documentar — Documentador (condicional):** <!-- agentic-phase {"id":"feature-document","role":"documentador"} --> ejecutar solo cuando el gate canónico
   autorice trabajo documental o de memoria durable.

En `light` compacto, el marcador estructural anterior sustituye la secuencia
general: el Planificador absorbe la exploración mínima y el Evaluador combinado
realiza la validación independiente. Cada ruta consume los contratos y gates
transversales de la política canónica sin reinterpretar sus excepciones. Cada
fase devuelve un `RoleReport` y solo el orquestador lo entrega a
`OrchestrationKernel.apply`.
