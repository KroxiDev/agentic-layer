# Capa agéntica reusable

Estas instrucciones son globales para este repositorio. `.agents/` es la fuente
de verdad del proceso; `.codex/`, `.claude/` y `CLAUDE.md` son adapters y no
deben duplicar sus políticas.

## Activación y modo

- `.agents/policies/orquestacion.md` es la fuente normativa para clasificar la
  activación antes de mutar y para ejecutar cualquier tarea orquestada.
- Activar la skill `orquestar` cuando el usuario lo pida o cuando esa política
  clasifique una señal cerrada de `full` automático. Dentro de la capa, `full`
  es el modo predeterminado.
- Usar `light` únicamente por petición explícita del usuario. No usarlo como
  nombre de modelo ni como nivel de razonamiento.
- Permitir ejecución directa verificada solo cuando cumpla todos los límites de
  la política; la entrega debe justificar la elegibilidad y citar su validación.
- Una instrucción explícita de trabajar `sin orquestar` no permite omitir
  seguridad, acciones restringidas ni una decisión indispensable. Si impide una
  ejecución directa válida, detenerse y explicar el límite concreto.
- Excepción bootstrap: si el propietario exige `sin orquestar` para reparar un
  defecto demostrado de esta misma capa canónica desde una especificación
  externa cerrada, aplicar la excepción delimitada por la política. Trabajar un
  solo agente, sin DevSession ni roles, y conservar todas las validaciones y
  restricciones.
- Consultar antes de mutar solo cuando falte un hecho que cambiaría la categoría.
- Responder en español neutro, salvo instrucción explícita en contrario.

## Requisitos globales

- CodeGraph es obligatorio y la vía primaria para entender o localizar código
  en repositorios indexados.
- Engram es obligatorio para historial y conocimiento durable, con ámbito de
  proyecto por defecto.
- La plataforma debe poder crear los subagentes aislados requeridos por toda
  tarea orquestada.
- El preflight de una tarea orquestada falla de forma cerrada: no sustituir un
  requisito ausente con búsquedas manuales, memoria improvisada, ejecución
  secuencial ni procesos auxiliares.

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

## Desarrollo

- Antes de agregar o modificar código o pruebas, leer y aplicar `.agents/policies/regla-de-oro.md`, tanto en tareas directas como orquestadas.

## Proyecto

<!-- agentic-contract-field purpose -->
- Propósito: mantener una plantilla declarativa y reusable de desarrollo
  asistido por agentes, adoptable con un solo comando mediante una CLI
  distribuible y sin dependencias.
<!-- agentic-contract-field architecture -->
- Arquitectura: núcleo canónico en `.agents/`, protocolo estructurado vigente en
  `.agents/kernel/` con única interface `apply/inspect`, schemas y conformidad;
  `schemaVersion` identifica el formato persistido sin negociación. El seam de
  configuración del proyecto vive en `AGENTS.md`; `.agents/protocol.json`
  declara el inventario instalado y los overrides del host, consumidos mediante
  `.agents/kernel/protocol-manifest.mjs`. La composición productiva única vive
  en `.agents/kernel/composition.mjs`; el inicializador único vive en
  `scripts/agentic-init.mjs`, el check sintáctico derivado en
  `scripts/agentic-check.mjs`, el ejecutable delgado en `bin/agentic.mjs`, el
  inventario npm de `package.json` es una proyección exacta, los adapters
  delgados viven en `.codex/`, `.claude/` y `CLAUDE.md`, y las pruebas públicas
  en `tests/`.
<!-- agentic-contract-field entrypoints -->
- Entrypoints: `AGENTS.md`, `bin/agentic.mjs`, `scripts/agentic-init.mjs`,
  `scripts/agentic-check.mjs`, `.agents/kernel/composition.mjs`,
  `.agents/kernel/orchestration-kernel.mjs`,
  `.agents/kernel/protocol-manifest.mjs`, `.agents/protocol.json`,
  `.agents/skills/orquestar/SKILL.md` y `CLAUDE.md`.

## Validación

<!-- agentic-contract-field focusedValidation -->
- Focalizada: ejecutar `npm run check` —que deriva de `.agents/protocol.json`
  todos los módulos distribuidos— y el caso relacionado de
  `node --test --test-name-pattern="<patrón concreto del caso relacionado>"`;
  sustituir el placeholder por el nombre o patrón exacto antes de ejecutar el
  comando.
<!-- agentic-contract-field completeValidation -->
- Completa: ejecutar `node --test`,
  `node scripts/agentic-init.mjs --dry-run --yes` y `npm pack --dry-run`; la
  suite incluye la validación estructural, el inventario exacto del paquete y
  simulaciones completas en directorios temporales. Toda verificación del
  artefacto empaquetado se realiza en directorios temporales, nunca contra el
  registro.

## Tests

<!-- agentic-contract-field testFramework -->
- Framework: `node:test`, sin dependencias externas.
<!-- agentic-contract-field testLocation -->
- Ubicación: `tests/*.test.mjs`, por interfaz pública; el kernel se cubre en
  `tests/orchestration-kernel.test.mjs`, la composición distribuida en
  `tests/productive-composition.test.mjs` y los helpers CLI compartidos viven en
  `tests/agentic-test-helpers.mjs`.
<!-- agentic-contract-field testLifecycle -->
- Ciclo de vida: conservar casos permanentes para el comportamiento público del
  inicializador, `update`, Codex, el kernel y la distribución; cada archivo
  usa un directorio raíz temporal exclusivo y autolimpiable para fixtures y simulaciones.

## Git

<!-- agentic-contract-field gitStrategy -->
- Rama o estrategia permitida: trabajar sobre `main` local; no crear, cambiar,
  fusionar ni publicar ramas, ni hacer push al remoto, sin instrucción
  explícita del propietario.

## Seguridad

<!-- agentic-contract-field secrets -->
- Secretos: este repositorio no requiere ni almacena secretos; publicar en npm
  exige un token que nunca debe versionarse ni escribirse en archivos del
  repositorio.
<!-- agentic-contract-field protectedPaths -->
- Rutas protegidas: no versionar índices de CodeGraph, memorias de Engram,
  sesiones reales, configuraciones personales locales, `node_modules/` ni los
  tarballs generados por `npm pack`.
<!-- agentic-contract-field immutableData -->
- Datos inmutables: No aplica.
<!-- agentic-contract-field restrictedActions -->
- Acciones restringidas: el inicializador no puede instalar herramientas,
  acceder a remotos, publicar paquetes ni modificar Git; solo puede inicializar
  o sincronizar CodeGraph mediante una bandera de confirmación explícita.
  `npm publish`, `npm version`, la creación de tags y cualquier acceso al
  registro requieren autorización explícita del propietario en cada ocasión.
<!-- agentic-contract-field originContamination -->
- Contaminación de origen: No aplica para esta fuente canónica. Toda extracción
  distinta debe declarar en su contrato un corpus reproducible de marcadores o
  justificar explícitamente `No aplica` antes de aprobar la distribución.

## Documentación

<!-- agentic-contract-field documentation -->
- README y documentación técnica: `README.md` documenta adopción, opciones,
  modos, roles y errores comunes; `CONTEXT.md` fija el glosario del dominio;
  `docs/arquitectura.md` mantiene la estructura, los flujos y la frontera de
  distribución; `.agents/README.md` documenta el módulo interno y
  `docs/adr/0011-kernel-estructurado.md` fija la frontera del kernel.
  La composición, su recuperación y el inventario sintáctico se documentan en
  esos mismos artefactos. `CONTEXT.md` y `docs/` no se distribuyen. Actualizar los pertinentes
  cuando cambien el kernel, protocolo, inicializador, ejecutable, sus pruebas o
  las garantías de distribución.
<!-- agentic-contract-field adrs -->
- ADRs: `docs/adr/`, con numeración secuencial `NNNN-slug.md`; crear una sólo
  cuando la decisión sea difícil de revertir, sorprendente sin contexto y
  resultado de un trade-off real.

<!-- AGENTIC_PROJECT_CONTRACT_END -->
