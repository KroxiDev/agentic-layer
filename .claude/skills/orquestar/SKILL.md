---
name: orquestar
description: Activa en Claude Code el pipeline agéntico para solicitudes explícitas o cuando la política canónica clasifica una señal cerrada de full automático; light requiere petición explícita.
---

<!-- agentic-protocol -->

Leer `.agents/skills/orquestar/SKILL.md` y
`.agents/policies/orquestacion.md`, y ejecutar ese protocolo mediante los
subagentes nativos definidos en `.claude/agents/`. Conducir el kernel con
`node .agents/scripts/kernel-cli.mjs` (`apply`, `inspect` y `help <tipo>` con
las claves exactas de payload), el adapter delgado de
`.agents/kernel/composition.mjs`, única composición productiva de
`.agents/kernel/orchestration-kernel.mjs`: entregar un `WorkEnvelope` a cada
rol y devolver su `RoleReport` al kernel, sin mutar estado desde el adapter.
Este archivo es solo un adapter: no reinterpretar ni duplicar las políticas
canónicas.
