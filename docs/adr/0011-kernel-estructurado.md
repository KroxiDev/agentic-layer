# ADR 0011: kernel estructurado

- Estado: aceptada
- Fecha: 2026-08-17

## Contexto

La coordinación requiere una autoridad única para estado, revisiones,
idempotencia, presupuesto, aceptación, validación y telemetría. Si esas
invariantes se reparten entre política, adapters y prosa Markdown, los callers
pueden competir por la misma transición y la interface crece con cada comando.

## Decisión

Adoptar `OrchestrationKernel` como módulo profundo del protocolo estructurado.
Su instancia expone únicamente:

- `apply(command)` para todas las mutaciones;
- `inspect(sessionId)` para vistas de solo lectura.

El kernel concentra máquina de estados, capacidad opaca del orquestador,
idempotencia global, CAS, aceptación congelada, presupuesto uniforme, lane
`full:<generation>`, clasificación de findings, persistencia y telemetría.
`StateStore`, `Clock`, `EnvironmentProbe` y `EventSink` son seams internos con
adapters de producción y memoria o fakes para tests.

Los roles reciben un `WorkEnvelope` inmutable y devuelven un `RoleReport`;
nunca poseen capacidad ni mutan el ledger. Markdown es solo una vista humana.
`schemaVersion` identifica el único formato persistido admitido, sin
negociación. Kernel, políticas, roles, workflows, templates y schemas forman el
inventario indivisible declarado en `.agents/protocol.json`. La conformidad
rechaza mezclas, overrides no declarados o cambios en la interface.

El mismo manifiesto declara cada ruta, asset, marker, directorio gestionado y
override público. `protocol-manifest.mjs` valida esa declaración y proyecta las
listas consumidas por conformidad, inicializador y distribución. Los únicos
overrides del host son `contextBudgetBytes` y `telemetrySink`; este último se
resuelve contra un mapa explícito de `telemetrySinks`. `capabilityTtlMs` se
mantiene como opción interna del constructor porque controla seguridad, no el
contrato configurable del proyecto.

## Alternativas descartadas

1. **Métodos públicos por transición:** acoplan callers y tests a la máquina
   interna y amplían la superficie de cambio.
2. **Estado autoritativo en Markdown:** obliga a inferir gates desde prosa y no
   ofrece CAS ni idempotencia estructurada.
3. **Mutación desde los roles:** rompe el ownership único y expone capacidades
   fuera del orquestador.

## Consecuencias

- Las sesiones tienen estado y causa deterministas; un retry idéntico no duplica
  efectos y un rol no puede mutar.
- El preflight ambiental ocurre antes del primer snapshot.
- Un outbox persistido junto al snapshot cierra la ventana entre persistencia y
  telemetría; los retries entregan eventos pendientes con deduplicación durable.
- La conformidad recorre el inventario declarado completo y valida
  semánticamente cada schema antes de que pueda comenzar una `DevSession`.
- El inicializador y el inventario npm son proyecciones del manifiesto; no
  mantienen listas paralelas editables.
- Un finding nuevo crítico pausa para decisión de alcance y no amplía producto
  silenciosamente.
- La capacidad vive fuera de snapshots, sobres y reportes. Tras una expiración,
  el host solo puede obtener otra repitiendo exactamente el comando de inicio
  con la capacidad bootstrap.
- Una reparación demostrada del propio runtime puede usar la excepción
  bootstrap explícita: un solo agente, sin ejecutar DevSession ni roles del
  runtime defectuoso y con todos los gates de validación intactos.
