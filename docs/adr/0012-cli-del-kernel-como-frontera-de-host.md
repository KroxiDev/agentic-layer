# 0012 — CLI del kernel como frontera de host

- Estado: aceptada
- Fecha: 2026-08-19

## Contexto

El kernel no tenía CLI. Para cada transición, el orquestador debía escribir
Node inline que importara `.agents/kernel/composition.mjs`, y para construir un
payload válido necesitaba leer 83 KB de kernel o 18 KB de schemas, o cobrar
`invalid_command` hasta acertar. El coste fijo medido por tarea orquestada
(~12k tokens de arranque, ~5k por despacho) dependía en parte de esa
duplicación entre prosa y protocolo.

Dos restricciones daban forma al problema:

1. La capacidad del orquestador es identidad de objeto en memoria
   (`createBootstrapCapability()` devuelve un objeto opaco comparado por
   `===`). No es serializable y la política prohíbe persistirla: un proceso
   CLI efímero nace sin autoridad sobre una sesión existente.
2. `kernelInterface` está congelada en `["apply", "inspect"]` por la suite de
   conformidad: cualquier método nuevo es drift.

## Decisión

- Un CLI delgado en `.agents/scripts/kernel-cli.mjs`, adapter de
  `createOrchestrationComposition`, con tres subcomandos: `inspect`, `apply` y
  `help <tipo>`. No añade métodos al kernel ni contiene lógica de negocio.
- La recuperación de autoridad usa el estado del propio kernel: `startState`
  persiste el `start-session` exacto (sin capacidad) en
  `recovery.bootstrapCommand`, `inspect` lo expone, y el CLI lo repite con una
  capacidad bootstrap nueva en cada invocación. **No existe un archivo de
  recuperación del lado del host**: sería un duplicado con ventana de
  divergencia (crash entre `apply` y su escritura) de un dato que el snapshot
  ya conserva atómicamente con la creación de la sesión.
- `COMMAND_PAYLOAD_KEYS` se exporta del kernel como estructura congelada.
  `help <tipo>` la imprime tal cual: la lista de claves admitidas tiene una
  sola fuente y un test falla si CLI y kernel divergen. Exportar una constante
  no altera `kernelInterface`, que solo cubre métodos del prototipo.
- Contrato de salida: JSON por stdout, `KernelError` por stderr con su `code`
  intacto y exit code distinto de cero. `actorCapability` se elimina de toda
  salida serializada.

## Consecuencias

- La política de orquestación puede dejar de duplicar la forma de los comandos:
  nombra cada garantía con su código de error y delega la lista viva de claves
  en `help <tipo>`. Las aserciones de prosa correspondientes se movieron al
  schema del `WorkEnvelope` y a la salida del CLI.
- La frontera host/kernel queda fijada: los hosts (skills de Codex y Claude
  Code) conducen el kernel por el CLI y no escriben composición inline; los
  roles siguen sin recibir capacidad ni invocar `apply`.
- El CLI viaja en la distribución: está declarado en `.agents/protocol.json`,
  proyectado en `package.json` → `files` y cubierto por `npm run check` y
  `tests/kernel-cli.test.mjs` (sesión completa por procesos separados,
  idempotencia, CAS e higiene de capacidades).
