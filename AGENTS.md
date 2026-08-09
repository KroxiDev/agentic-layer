# Capa agéntica reusable

Estas instrucciones son globales para este repositorio. `.agents/` es la fuente
de verdad del proceso; `.codex/`, `.claude/` y `CLAUDE.md` son adapters y no
deben duplicar sus políticas.

## Activación y modo

- Leer `.agents/policies/orquestacion.md` antes de ejecutar una tarea
  orquestada.
- Activar la skill `orquestar` cuando el usuario lo pida o cuando la tarea sea
  no trivial. El modo predeterminado es `full`.
- Usar `light` únicamente por petición explícita del usuario. No usarlo como
  nombre de modelo ni como nivel de razonamiento.
- Resolver cambios triviales, locales y evidentes sin pipeline. Si la
  clasificación es dudosa, consultar antes de actuar.
- Responder en español neutro, salvo instrucción explícita en contrario.

## Requisitos globales

- CodeGraph es obligatorio y la vía primaria para entender o localizar código
  en repositorios indexados.
- Engram es obligatorio para historial y conocimiento durable, con ámbito de
  proyecto por defecto.
- La plataforma debe poder crear los subagentes aislados requeridos.
- El preflight falla de forma cerrada: no sustituir un requisito ausente con
  búsquedas manuales, memoria improvisada, ejecución secuencial ni procesos
  auxiliares.

## Precedencia

1. Instrucciones de la plataforma y del usuario.
2. Reglas globales de este archivo.
3. Overrides del `AGENTS.md` más cercano al sector afectado.
4. Políticas genéricas de `.agents/`.
5. Instrucciones técnicas de los adapters.

Las restricciones de seguridad se acumulan y prevalece siempre la más estricta.
Ante instrucciones no relacionadas con seguridad que sean irreconciliables,
detenerse y consultar al usuario.

## `AGENTS.md` locales

Un `AGENTS.md` anidado puede redefinir para su sector arquitectura, validación,
tests y documentación. No puede debilitar requisitos globales de seguridad,
herramientas u orquestación. Si una tarea cruza sectores, acumular las
validaciones compatibles y consultar cualquier conflicto real.

<!-- AGENTIC_PROJECT_CONTRACT_START -->

## Proyecto

- Propósito: mantener una plantilla declarativa y reusable de desarrollo
  asistido por agentes, adoptable con un solo comando mediante una CLI
  distribuible y sin dependencias.
- Arquitectura: núcleo canónico en `.agents/`, seam de configuración en
  `AGENTS.md`, única implementación del inicializador en
  `scripts/agentic-init.mjs`, ejecutable delgado en `bin/agentic.mjs`,
  manifiesto e inventario de distribución en `package.json`, adapters delgados
  en `.codex/`, `.claude/` y `CLAUDE.md`, y pruebas de la interfaz CLI en
  `tests/`.
- Entrypoints: `AGENTS.md`, `bin/agentic.mjs`, `scripts/agentic-init.mjs`,
  `.agents/skills/orquestar/SKILL.md` y `CLAUDE.md`.

## Validación

- Focalizada: ejecutar `node --check scripts/agentic-init.mjs`,
  `node --check bin/agentic.mjs` y el caso relacionado de
  `node --test tests/agentic-init.test.mjs`.
- Completa: ejecutar `node --test tests/agentic-init.test.mjs`,
  `node scripts/agentic-init.mjs --dry-run --yes` y `npm pack --dry-run`; la
  suite incluye la validación estructural, el inventario exacto del paquete y
  simulaciones completas en directorios temporales. Toda verificación del
  artefacto empaquetado se realiza en directorios temporales, nunca contra el
  registro.

## Tests

- Framework: `node:test`, sin dependencias externas.
- Ubicación: `tests/agentic-init.test.mjs`.
- Ciclo de vida: conservar casos permanentes para el comportamiento público del
  inicializador y usar únicamente directorios temporales autolimpiables para
  fixtures y simulaciones.

## Git

- Rama o estrategia permitida: trabajar sobre `main` local; no crear, cambiar,
  fusionar ni publicar ramas, ni hacer push al remoto, sin instrucción
  explícita del propietario.

## Seguridad

- Secretos: este repositorio no requiere ni almacena secretos; publicar en npm
  exige un token que nunca debe versionarse ni escribirse en archivos del
  repositorio.
- Rutas protegidas: no versionar índices de CodeGraph, memorias de Engram,
  sesiones reales, configuraciones personales locales, `node_modules/` ni los
  tarballs generados por `npm pack`.
- Datos inmutables: No aplica.
- Acciones restringidas: el inicializador no puede instalar herramientas,
  acceder a remotos, publicar paquetes ni modificar Git; solo puede inicializar
  o sincronizar CodeGraph mediante una bandera de confirmación explícita.
  `npm publish`, `npm version`, la creación de tags y cualquier acceso al
  registro requieren autorización explícita del propietario en cada ocasión.
- Contaminación de origen: No aplica para esta fuente canónica. Toda extracción
  distinta debe declarar en su contrato un corpus reproducible de marcadores o
  justificar explícitamente `No aplica` antes de aprobar la distribución.

## Documentación

- README y documentación técnica: `README.md` documenta adopción, la CLI
  distribuible y su operación avanzada, y `.agents/README.md` documenta el
  módulo interno; actualizar ambos cuando cambien el inicializador, el
  ejecutable, sus pruebas o las garantías de distribución.
- ADRs: No aplica hasta que el propietario declare una ubicación en este
  contrato.

<!-- AGENTIC_PROJECT_CONTRACT_END -->
