---
name: orquestar
description: Activa en Claude Code el pipeline agéntico para solicitudes explícitas o cuando la política canónica clasifica una señal cerrada de full automático; light requiere petición explícita.
---

<!-- agentic-protocol:v2 -->

Leer `.agents/skills/orquestar/SKILL.md` y
`.agents/policies/orquestacion.md`, y ejecutar ese protocolo mediante los
subagentes nativos definidos en `.claude/agents/`. Para sesiones nuevas, usar
`.agents/kernel/orchestration-kernel.mjs`: entregar un `WorkEnvelope` a cada rol
y devolver su `RoleReport` al kernel, sin mutar estado desde el adapter. Usar
`.agents/scripts/session-controller.mjs` únicamente para reanudar una sesión v1
durante la ventana de compatibilidad. Este archivo es solo un adapter: no
reinterpretar ni duplicar las políticas canónicas.
