# Workflow: architecture

Usar para decisiones de diseño con consecuencias durables.

1. **Explorar — Explorador:** describir estado actual, restricciones, seams,
   dependencias y decisiones previas.
2. **Comparar — Planificador:** presentar dos o tres opciones con trade-offs,
   impacto y recomendación; activar grilling si falta una decisión del usuario.
3. **Proponer registro — Documentador:** redactar una ADR propuesta en la
   ubicación declarada por `AGENTS.md`. Si ADRs es `No aplica`, mantener la
   propuesta en la DevSession sin inventar una ruta.
4. **Aprobar — Usuario mediante el orquestador:** no implementar sin aprobación
   explícita.
5. **Implementar:** ejecutar `feature` o `refactor`, según corresponda, usando la
   decisión aprobada como restricción.
6. **Evaluar — Evaluador:** verificar que la implementación respeta la decisión
   y que la evidencia cubre sus consecuencias.
7. **Documentar — Documentador:** confirmar el estado de la ADR si existe y
   consolidar memoria durable.

`Light` solo puede aplicarse al workflow posterior de implementación y requiere
una petición explícita; no reduce exploración, comparación ni aprobación.
