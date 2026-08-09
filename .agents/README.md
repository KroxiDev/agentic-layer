# Núcleo de la capa agéntica

`.agents/` es el módulo reusable y la única fuente de verdad del proceso. Su
interface de configuración es el contrato delimitado de `AGENTS.md`: un
proyecto consumidor declara allí sus hechos, comandos y restricciones sin
editar roles, workflows, políticas, skills ni adapters.

`scripts/agentic-init.mjs` es la única superficie de adopción automatizada. No
forma parte del núcleo de orquestación: detecta hechos del proyecto, copia o
valida el inventario canónico y modifica exclusivamente el bloque contractual
de `AGENTS.md`. Su comportamiento público se verifica en
`tests/agentic-init.test.mjs` con `node:test` y directorios temporales.

## Mapa

- `policies/`: reglas transversales de orquestación y SDD/TDD.
- `roles/`: responsabilidades, límites y contratos de salida de seis roles.
- `workflows/`: orden de fases para feature, bugfix, refactor y architecture.
- `skills/`: procedimientos portables invocados por el orquestador o los roles.
- `templates/dev-session.md`: estado efímero compartido entre fases.
- `sessions/`: instancias de DevSession ignoradas por control de versiones.
- `../scripts/agentic-init.mjs`: inicializador local sin dependencias externas.
- `../tests/agentic-init.test.mjs`: pruebas de adopción, seguridad e
  idempotencia.

## Interface y adapters

El seam externo es `AGENTS.md`. El núcleo interpreta su contrato efectivo,
incluidos los overrides locales, y mantiene el comportamiento común.

- Codex descubre los roles en `.codex/agents/*.toml`.
- Claude Code descubre los roles en `.claude/agents/*.md` y el wrapper público
  en `.claude/skills/orquestar/SKILL.md`.
- `CLAUDE.md` importa el `AGENTS.md` raíz.

Los adapters solo aplican restricciones técnicas y apuntan a archivos
canónicos. No contienen workflows ni políticas completas.

## Invariantes

1. CodeGraph, Engram y subagentes son requisitos obligatorios con fallo cerrado.
2. Cada fase corre en un contexto aislado y devuelve solo el reporte del rol.
3. `full` es el modo predeterminado; `light` requiere petición explícita.
4. La DevSession es efímera y no se reemplaza con memoria durable.
5. Engram conserva únicamente conocimiento validado, reutilizable y
   accionable.
6. Ningún proyecto necesita personalizar archivos distintos de `AGENTS.md`.
7. El inicializador nunca sobrescribe una colisión, instala herramientas,
   accede a remotos ni modifica Git.
8. CodeGraph solo se inicializa o sincroniza mediante confirmación explícita;
   las comprobaciones predeterminadas son de solo lectura.
