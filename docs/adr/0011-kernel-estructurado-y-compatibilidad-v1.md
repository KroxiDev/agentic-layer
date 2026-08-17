# ADR 0011: kernel estructurado con compatibilidad v1 aislada

- Estado: aceptada
- Fecha: 2026-08-17

## Contexto

La coordinación v1 repartía autoridad entre política, adapters, roles y una CLI
que reescribía Markdown. Esa frontera permitió que prosa narrativa afectara
gates, que un rol y el orquestador compitieran por la misma revisión, que el
presupuesto divergiera entre modos y que la validación integral no tuviera un
lane propio. Corregir cada síntoma en la CLI habría ampliado una interface ya
superficial y mantenido ownership ambiguo.

La migración debe preservar sesiones v1 activas y la distribución sin
dependencias externas. No puede convertir historia incompleta en hechos
estructurados por inferencia.

## Decisión

Adoptar `OrchestrationKernel` como módulo profundo del protocolo V2. Su instancia
expone únicamente:

- `apply(command)` para todas las mutaciones;
- `inspect(sessionId)` para vistas de solo lectura.

El kernel concentra máquina de estados, capacidad opaca del orquestador,
idempotencia global, CAS, aceptación congelada, presupuesto uniforme, lane
`full:<generation>`, clasificación de findings, persistencia y telemetría.
`StateStore`, `Clock`, `EnvironmentProbe` y `EventSink` son seams internos con
adapters de producción y memoria/fakes para tests.

Los roles reciben `WorkEnvelope` inmutable y devuelven `RoleReport`; nunca
poseen capacidad ni mutan el ledger. Markdown pasa a ser vista humana. El
controller actual se conserva marcado como runtime v1; `LegacyV1Adapter` lee y
migra explícitamente solo en checkpoints sin actividad, marcando toda
ambigüedad.

Kernel, políticas, roles, workflows, templates y schemas se versionan como un
conjunto en `.agents/protocol.json`. Un gate de conformidad rechaza mezclas,
overrides no declarados o cambios en la interface.

## Alternativas descartadas

1. **Extender `session-controller.mjs`:** preservaba regex y ownership repartido;
   cada nueva transición aumentaba la superficie pública.
2. **Reescribir todas las sesiones v1:** podía inventar actor, tiempos,
   aceptación o veredictos y romper intentos activos.
3. **Métodos públicos por transición:** hacía que callers y tests dependieran de
   la máquina interna y dificultaba migraciones posteriores.
4. **Eliminar v1 de inmediato:** impedía terminar sesiones activas y volvía el
   rollout irreversible.

## Consecuencias

- Las sesiones nuevas tienen estado y causa deterministas; un retry idéntico no
  duplica efectos y un rol no puede mutar.
- El preflight ambiental ocurre antes del primer snapshot.
- Un outbox persistido junto al snapshot cierra la ventana entre commit y
  telemetría; los retries entregan eventos pendientes con deduplicación durable.
- Un finding nuevo crítico pausa para decisión de alcance y no se convierte en
  producto nuevo silenciosamente.
- Durante la ventana de soporte existen dos formatos legibles, pero solo V2 es
  el runtime principal para sesiones nuevas.
- La capacidad vive fuera de snapshots y sobres. El host la conserva durante
  la ejecución normal; tras un reinicio o expiración solo puede recuperar una
  capacidad nueva repitiendo exactamente el `start-session` o `migrate-v1`
  original con la capacidad bootstrap.
- La retirada del lector v1 no puede ocurrir antes del 2026-11-17 y queda además
  condicionada a dos releases estables y cero sesiones v1 activas en
  consumidores prioritarios.
- Una reparación demostrada del propio runtime puede usar la excepción
  bootstrap explícita: un solo agente, sin ejecutar DevSession ni roles de la
  versión defectuosa y con todos los gates de validación intactos.
