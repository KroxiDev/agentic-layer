# Workflow: architecture

Usar para decisiones de diseño con consecuencias durables.

1. **Explorar — Explorador:** <!-- agentic-phase:v1 {"id":"architecture-explore","role":"explorador"} --> describir estado actual, restricciones, seams,
   dependencias y decisiones previas.
2. **Comparar — Planificador:** <!-- agentic-phase:v1 {"id":"architecture-plan","role":"planificador"} --> presentar dos o tres opciones con trade-offs,
   impacto y recomendación; activar grilling si falta una decisión del usuario.
3. **Proponer registro — Documentador:** <!-- agentic-phase:v1 {"id":"architecture-propose","role":"documentador"} --> redactar una ADR propuesta en la
   ubicación declarada por `AGENTS.md`. Si ADRs es `No aplica`, mantener la
   propuesta en la DevSession sin inventar una ruta.
4. **Aprobar — Usuario mediante el orquestador:** no implementar sin aprobación
   explícita.
5. **Registrar decisión — Documentador:** <!-- agentic-phase:v1 {"id":"architecture-record","role":"documentador"} --> marcar la ADR como aceptada o registrar
   la decisión aprobada en la ubicación autorizada y consolidar memoria durable.

`Light` solo puede aplicarse al workflow posterior de implementación y requiere
una petición explícita; no reduce exploración, comparación ni aprobación.

Una tarea exclusivamente arquitectónica termina después de
`architecture-record`; no exige unidades de implementación, fan-in ni
evaluación de código.

Si la decisión aprobada debe implementarse, cerrar `architecture` y transferirla
una sola vez a `feature` o `refactor` como restricción y criterio de aceptación.
Ese workflow posterior es el único responsable de implementar una a tres
unidades, testearlas, ejecutar fan-in, evaluar y documentar el resultado final.
`architecture` no vuelve a evaluar ni documentar la implementación ya cerrada.
