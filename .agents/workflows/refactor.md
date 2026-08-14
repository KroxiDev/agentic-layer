# Workflow: refactor

Usar para reestructurar una implementación sin cambiar su comportamiento
observable.
Las mecánicas comunes de modo, unidades, validación, evaluación y cierre
pertenecen a la [política de orquestación](../policies/orquestacion.md); este
archivo fija únicamente el orden y la intención de las fases de `refactor`.

<!-- agentic-light-sequence:v1 {"phases":["refactor-plan","refactor-implement","refactor-evaluate"]} -->

1. **Explorar — Explorador:** <!-- agentic-phase:v1 {"id":"refactor-explore","role":"explorador"} --> delimitar sector, dependientes, seams y reglas
   efectivas.
2. **Definir invariantes — Planificador:** <!-- agentic-phase:v1 {"id":"refactor-plan","role":"planificador"} --> enumerar lo que no debe cambiar y la
   evidencia que lo protege.
3. **Implementar — Implementador:** <!-- agentic-phase:v1 {"id":"refactor-implement","role":"implementador"} --> cambiar en pasos pequeños dentro del sector
   aprobado.
4. **Testear — Tester:** <!-- agentic-phase:v1 {"id":"refactor-test","role":"tester"} --> comprobar invariantes con la validación declarada.
5. **Evaluar — Evaluador:** <!-- agentic-phase:v1 {"id":"refactor-evaluate","role":"evaluador"} --> verificar ausencia de regresiones y una mejora real
   de profundidad, leverage o localidad, sin abstracción gratuita.
6. **Documentar — Documentador (condicional):** <!-- agentic-phase:v1 {"id":"refactor-document","role":"documentador"} --> ejecutar solo cuando el gate canónico
   autorice trabajo documental o de memoria durable.

En `light` compacto, el marcador estructural anterior sustituye la secuencia
general: el Planificador absorbe la exploración mínima y el Evaluador combinado
verifica invariantes y validación focalizada. No introducir seams ni
abstracciones nuevas salvo que sean el objeto explícito aprobado.

Cada unidad declarada debe preservar los invariantes observables de este
workflow. Dependencias, ownership, testing, retrabajo y cierre consumen los
contratos de la política canónica sin redefinirlos aquí.
