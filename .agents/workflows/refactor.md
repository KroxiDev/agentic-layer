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
6. **Documentar — Documentador (condicional):** <!-- agentic-phase:v1 {"id":"refactor-document","role":"documentador"} --> abrir únicamente cuando el gate de la
   política de orquestación detecte documentación o memoria durable pendiente.

En `light` no introducir seams ni abstracciones nuevas salvo que sean el objeto
explícito aprobado.

Cada unidad de implementación debe preservar invariantes observables, declarar
dependencias y ownership, y recibir testing inmediato antes de habilitar la
siguiente mediante validación focalizada concreta. Tras el fan-in de todas las
unidades consolidadas, `full` ejecuta una sola validación completa. Un Evaluador
de solo lectura cubre Estándares y Especificación de forma combinada por defecto;
dos Evaluadores independientes solo se habilitan con estrategia dual y un
`evaluationRisk` admitido y registrado antes del fan-in.

Un Tester rojo o fallido reabre retrabajo sin validar. Cada nuevo fan-in
invalida la generación anterior y exige reevaluar sus ejes.

La validación por unidad y la fase Documentador aplican los gates canónicos de
la política de orquestación; los roles no reinterpretan sus excepciones.
