@AGENTS.md

<!-- agentic-protocol -->

Cuando se active la capa agéntica, leer
`.agents/policies/orquestacion.md`. Las reglas configurables viven únicamente
en archivos `AGENTS.md`. Para sesiones nuevas, el único propietario de las
transiciones es `.agents/kernel/orchestration-kernel.mjs`; los roles consumen
`WorkEnvelope` y devuelven `RoleReport` sin mutar el estado. El archivo
`.agents/kernel/protocol.mjs` define el contrato estructurado vigente.
