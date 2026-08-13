# Núcleo de la capa agéntica

`.agents/` es el módulo reusable y la única fuente de verdad del proceso. Su
interface de configuración es el contrato delimitado de `AGENTS.md`: un
proyecto consumidor declara allí sus hechos, comandos y restricciones sin
editar roles, workflows, políticas, skills ni adapters.

`scripts/agentic-init.mjs` es la única superficie automatizada y la única
implementación de adopción y actualización. No forma parte del núcleo de
orquestación: detecta hechos y versiones, planifica el inventario canónico,
migra exclusivamente el bloque contractual de `AGENTS.md` y aplica cambios de
forma recuperable. `bin/agentic.mjs` es el ejecutable distribuible y solo
despacha `init` y `update` hacia esa implementación. Su comportamiento público
se verifica en `tests/agentic-init.test.mjs` con `node:test`, directorios
temporales y `CODEX_HOME` aislado.

El inicializador no interroga por hechos del contrato. Escribe lo que infiere
—incluidos los valores recomendados del perfil de ecosistema detectado— y deja
como `<pendiente: …>` lo que no puede inferir, listándolo al terminar en el
bloque `CONTRATO POR COMPLETAR`. Ese marcador es el que cobra la regla
`STRICT_PROJECT_CONTRACT_RULE` de `policies/orquestacion.md`: la primera sesión
del agente completa los huecos con la skill `agentic-grilling`, donde hay
contexto y conversación para decidirlos. `--purpose` y `--git-strategy` son un
atajo para declararlos en la propia adopción, nunca un requisito.

La capa se obtiene desde GitHub como paquete ejecutable y se adopta con
`npx --yes github:KroxiDev/agentic-layer init .`. La adopción es una
copia: el proyecto consumidor no declara dependencia, no consulta un upstream
y no recibe actualizaciones automáticas. Una copia existente se actualiza solo
por orden explícita con `agentic update`: el comando conserva DevSessions y
archivos ajenos, repara el inventario incluso con la misma versión y escribe
`.agents/VERSION` al final de la transacción.

Después de actualizar la capa, `update` puede habilitar explícitamente capacidad
técnica para 12 subagentes en un `config.toml` global o local. `--yes` no
autoriza esa operación: requiere `--codex-config global|local|none`. Los modos
conservan topes inferiores (`light = 4`, `full = 9`), independientes de ese
techo técnico. El editor conserva el TOML que no gestiona y deriva estructuras
ambiguas o strings multilínea a edición manual. Toda escritura autorizada usa
un temporal hermano y revalida ancestros no-follow justo antes de crearlo y
antes de la mutación final.

## Mapa

- `policies/`: orquestación, SDD/TDD y Regla de Oro para código y pruebas.
- `roles/`: responsabilidades, límites y contratos de salida de seis roles.
- `scripts/session-controller.mjs`: ciclo portable, recuperable e idempotente
  de DevSession global y SubDevSessions.
- `workflows/`: orden de fases para feature, bugfix, refactor y architecture.
- `skills/`: procedimientos portables invocados por el orquestador o los roles.
- `templates/`: formatos de la DevSession global y de los sobres de fase.
- `sessions/`: DevSessions globales y SubDevSessions efímeras ignoradas por
  control de versiones; `gitignore.asset` es el `.gitignore` que el
  inicializador instala allí.
- `VERSION`: versión de la capa adoptada. La genera el inicializador en el
  destino, no viaja en el paquete y permite clasificar una instalación como
  legacy, anterior, igual o posterior durante `update`. `policies/`, `roles/`, `skills/`, `templates/` y
  `workflows/` se gestionan por completo: al reemplazar, todo archivo ajeno al
  inventario canónico se elimina como residuo. `sessions/` y esta raíz no.
- `../bin/agentic.mjs`: ejecutable `agentic` con `init` y `update`.
- `../scripts/agentic-init.mjs`: inicializador y actualizador sin dependencias externas.
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

## Modelo de ejecución por unidades

El Planificador registra en la DevSession un DAG de una a tres unidades
verticales. Una unidad es estado durable de trabajo: `workUnitId`, criterios,
dependencias, oleada, permiso y `ownedPaths`. Un intento es una ejecución
monotónica de fase y rol asociada a esa unidad, carril o eje; conserva su propio
`baseRevision`, `threadId`, permiso, criterios, causa de retrabajo y evidencia.
Reintentar no crea otra unidad ni reactiva un intento terminal.

El controlador concentra las invariantes mecánicas detrás de su CLI:

1. valida DAG, ciclos, dependencias y ownership portable antes de despachar;
2. abre sólo unidades listas y hace cumplir los gates `implemented` →
   `validated` → `consolidated`;
3. reserva un único writer por identidad canónica del working tree, incluso
   entre DevSessions distintas;
4. calcula por separado capacidad total, carriles `read-only` y aislamiento de
   escritores;
5. habilita fan-in únicamente cuando todas las unidades están validadas y
   consolidadas;
6. versiona el fan-in y acepta sólo Evaluadores de la generación vigente.

La adquisición del writer lock publica por hard link un dueño exacto
`{session, attempt, workingTreeId}`. Una transición inicial o un checkpoint
recuperable exige seguir siendo dueño para liberar. Un terminal ya reconocido
libera sólo si el lock continúa siendo suyo: si un intento sucesor lo adquirió,
el reintento idempotente preserva la reserva ajena. Así `commit` y `fail`
recuperan interrupciones reales sin romper exclusión entre sesiones.

Las sesiones v1 sin unidades no se reinterpretan. Para una DevSession por
unidades creada antes de que existiera toda la trazabilidad, `open` falla
cerrado y exige repetir `init` con el plan aprobado. Ese upgrade sólo completa
campos ausentes —criterios, capacidades separadas y generación inicial—,
preserva estado e intentos y es byte-idempotente al repetirse.

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
12. `update` aplica primero la capa como una transacción recuperable y trata la
    configuración de Codex como una operación opcional posterior.
13. Los valores contractuales explícitos, incluidos autolinks y texto con
    ángulos, no se confunden con placeholders pendientes.
14. `light` admite como máximo 4 subagentes activos y `full` 9; el orquestador
    no cuenta y la capacidad técnica 12 de Codex no modifica esos topes.
15. Cada ruta writer tiene un único propietario y sólo existe una reserva de
    escritura activa por working tree.
16. Una dependencia se satisface sólo con validación atribuible del Tester; el
    fan-in y sus evaluaciones ocurren después de consolidar todas las unidades.
17. Reabrir una unidad incrementa la generación de evaluación e invalida todos
    sus ejes anteriores.
