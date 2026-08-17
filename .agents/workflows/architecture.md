# Workflow: architecture

<!-- agentic-workflow -->

Usar para decisiones de diseño con consecuencias durables.
Las mecánicas comunes de modo, delegación y cierre pertenecen a la
[política de orquestación](../policies/orquestacion.md); este archivo fija las
fases y el límite propio de una decisión arquitectónica.

1. **Explorar — Explorador:** <!-- agentic-phase {"id":"architecture-explore","role":"explorador"} --> describir estado actual, restricciones, seams,
   dependencias y decisiones previas.
2. **Comparar — Planificador:** <!-- agentic-phase {"id":"architecture-plan","role":"planificador"} --> presentar dos o tres opciones con trade-offs,
   impacto y recomendación; activar grilling si falta una decisión del usuario.
3. **Proponer registro — Documentador:** <!-- agentic-phase {"id":"architecture-propose","role":"documentador"} --> redactar una ADR propuesta en la
   ubicación declarada por `AGENTS.md`. Si ADRs es `No aplica`, mantener la
   propuesta en la DevSession sin inventar una ruta.
4. **Aprobar — Usuario mediante el orquestador:** no implementar sin aprobación
   explícita.
5. **Registrar decisión — Documentador:** <!-- agentic-phase {"id":"architecture-record","role":"documentador"} --> marcar la ADR como aceptada o registrar
   la decisión aprobada en la ubicación autorizada y consolidar memoria durable.

`architecture` no declara una secuencia compacta y no admite estrategia
`light`. Ese modo solo puede aplicarse al workflow posterior de implementación
y requiere una petición explícita; no reduce exploración, comparación ni
aprobación.

Una tarea exclusivamente arquitectónica termina después de
`architecture-record`; no exige unidades de implementación, fan-in ni
evaluación de código.

Si la decisión aprobada debe implementarse, cerrar `architecture` y transferirla
una sola vez a `feature` o `refactor` como restricción y criterio de aceptación.
Ese workflow posterior aplica la política canónica y es el único responsable de
implementar, verificar, evaluar y documentar el resultado final; `architecture`
no repite ese cierre. Cada fase devuelve un `RoleReport` y solo el
orquestador lo entrega a `OrchestrationKernel.apply`.
