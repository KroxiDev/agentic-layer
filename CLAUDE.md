@AGENTS.md

<!-- agentic-protocol:v2 -->

Cuando se active la capa agéntica, leer
`.agents/policies/orquestacion.md`. Las reglas configurables viven únicamente
en archivos `AGENTS.md`. Para sesiones nuevas, el único propietario de las
transiciones es `.agents/kernel/orchestration-kernel.mjs`; los roles consumen
`WorkEnvelope` y devuelven `RoleReport` sin mutar el estado. El archivo
`.agents/scripts/session-controller.mjs` se conserva solo para reanudar sesiones
v1 durante la ventana de compatibilidad.
