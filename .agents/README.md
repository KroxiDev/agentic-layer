# Núcleo de la capa agéntica

`.agents/` es el módulo reusable y la única fuente de verdad del proceso. Su
interface de configuración es el contrato delimitado de `AGENTS.md`: un
proyecto consumidor declara allí sus hechos, comandos y restricciones sin
editar roles, workflows, políticas, skills ni adapters.

`scripts/agentic-init.mjs` es la única superficie de adopción automatizada y la
única implementación del inicializador. No forma parte del núcleo de
orquestación: detecta hechos del proyecto, copia o valida el inventario
canónico y modifica exclusivamente el bloque contractual de `AGENTS.md`.
`bin/agentic.mjs` es el ejecutable distribuible y solo despacha el subcomando
`init` hacia esa implementación. Su comportamiento público se verifica en
`tests/agentic-init.test.mjs` con `node:test` y directorios temporales.

El inicializador no interroga por hechos del contrato. Escribe lo que infiere
—incluidos los valores recomendados del perfil de ecosistema detectado— y deja
como `<pendiente: …>` lo que no puede inferir, listándolo al terminar en el
bloque `CONTRATO POR COMPLETAR`. Ese marcador es el que cobra la regla
`STRICT_PROJECT_CONTRACT_RULE` de `policies/orquestacion.md`: la primera sesión
del agente completa los huecos con la skill `agentic-grilling`, donde hay
contexto y conversación para decidirlos. `--purpose` y `--git-strategy` son un
atajo para declararlos en la propia adopción, nunca un requisito.

La capa se distribuye como paquete npm y se adopta con
`npx --yes @kroxidev/agentic-layer init .`. La adopción es una copia: el
proyecto consumidor no declara dependencia, no consulta un upstream y no
recibe actualizaciones automáticas.

## Mapa

- `policies/`: reglas transversales de orquestación y SDD/TDD.
- `roles/`: responsabilidades, límites y contratos de salida de seis roles.
- `workflows/`: orden de fases para feature, bugfix, refactor y architecture.
- `skills/`: procedimientos portables invocados por el orquestador o los roles.
- `templates/dev-session.md`: estado efímero compartido entre fases.
- `sessions/`: instancias de DevSession ignoradas por control de versiones;
  `gitignore.asset` es el `.gitignore` que el inicializador instala allí.
- `VERSION`: versión de la capa adoptada. La genera el inicializador en el
  destino, no viaja en el paquete y permite reconocer una instalación previa
  para ofrecer su reemplazo. `policies/`, `roles/`, `skills/`, `templates/` y
  `workflows/` se gestionan por completo: al reemplazar, todo archivo ajeno al
  inventario canónico se elimina como residuo. `sessions/` y esta raíz no.
- `../bin/agentic.mjs`: ejecutable `agentic` con el subcomando `init`.
- `../scripts/agentic-init.mjs`: inicializador sin dependencias externas.
- `../tests/agentic-init.test.mjs`: pruebas de adopción, seguridad,
  idempotencia y contenido del paquete.

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
7. El inicializador nunca sobrescribe una colisión por defecto, instala
   herramientas, accede a remotos ni modifica Git. `--force` se limita a los
   archivos canónicos divergentes y nunca reescribe el seam `AGENTS.md`.
8. La adopción se completa con un solo comando: el inicializador no pregunta
   hechos del contrato ni falla por un dato ausente; lo marca como pendiente y
   deja que la regla estricta del contrato lo cobre antes de orquestar.
9. CodeGraph solo se inicializa o sincroniza mediante confirmación explícita;
   las comprobaciones predeterminadas son de solo lectura.
10. La distribución transporta únicamente el inventario canónico: nunca
    índices, memorias, sesiones reales, configuraciones personales ni tests.
11. La adopción no crea dependencia ni sincronización con la plantilla.
