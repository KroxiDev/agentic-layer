# Paralelismo controlado por unidades de implementación

**Estado: Aceptada**

## Contexto y problema

La capa dispone de una DevSession global y `WorkEnvelope` por intento mediante
el kernel estructurado. Ese protocolo hace trazables las fases y sus reintentos,
pero un workflow completo seguía
representándose como una secuencia de fases sin un modelo ejecutable para
dividir trabajo, expresar dependencias, atribuir validación o aprovechar
análisis independientes.

Codex puede sostener más contextos de los que conviene usar en un workflow. Un
solo límite de concurrencia confunde tres conceptos distintos: capacidad
técnica de la plataforma, presupuesto del modo y seguridad de escritura. Llenar
el cupo produciría coordinación artificial; mantener todo secuencial perdería
cobertura independiente y obligaría a contextos cada vez más grandes.

La solución debe permitir fan-out útil, principalmente de solo lectura, sin
introducir dos escritores sobre el mismo working tree, sin duplicar políticas
en adapters y sin convertir el kernel en un runtime que cree agentes. También
debe conservar recuperación e idempotencia cuando un intento terminal se
reintenta después de que otro writer adquirió la reserva.

## Fuerzas y restricciones

1. `light` admite como máximo 4 subagentes activos y `full` 9; el Orquestador no
   cuenta y los valores son máximos, no cuotas.
2. Codex debe poder habilitar capacidad técnica para 12 hilos, sin elevar 4/9.
3. La capacidad real puede ser menor y debe reducir el fan-out con agentes
   reales, nunca con simulaciones ni procesos auxiliares.
4. Una tarea puede necesitar una sola unidad; dividir por llenar cupos es peor
   que mantener una rebanada vertical coherente.
5. Sólo puede existir un writer activo por working tree sin aislamiento real
   mediante worktrees aprobados.
6. Cada ruta editable debe tener propietario exclusivo y comparación portable
   a Windows.
7. Las dependencias sólo pueden satisfacerse con evidencia atribuible del
   Tester, no con la mera finalización del Implementador.
8. La aprobación final requiere fan-in del resultado integrado y, en `full`,
   ejes independientes de Estándares y Especificación.
9. Codex y Claude deben exponer los mismos contratos y garantías observables.
10. La DevSession global sigue siendo la única fuente durable; los sobres
    continúan siendo efímeros.

## Decisión

Adoptar un modelo de paralelismo controlado por una a tres unidades verticales,
administrado por la DevSession y validado mecánicamente por
`.agents/kernel/orchestration-kernel.mjs`. La política decide qué agentes abrir;
el kernel sólo persiste y hace cumplir contratos, capacidad, ownership,
gates, locks y generaciones.

### D1. Unidad e intento son identidades distintas

Una **unidad de implementación** es trabajo durable y conserva el mismo
`workUnitId` durante implementación, testing y retrabajo. Declara criterios,
`dependsOn`, `ownedPaths`, permiso y oleada.

Un **intento** es una ejecución monotónica de fase y rol asociada a una unidad,
carril o eje. Declara `baseRevision`, `threadId`, criterios y permiso. El
retrabajo agrega causa, impacto cuando reabre una unidad validada e identidad
del intento anterior. Un intento terminal no se reactiva ni se sobrescribe.

La numeración monotónica pertenece a la fase; la relación con unidad, carril o
eje determina qué intento previo debe trazarse. Así pueden coexistir varias
unidades sin confundir una unidad nueva con el segundo intento de otra.

### D2. DAG, oleadas y gates

El Planificador puede registrar entre una y tres unidades. El controlador
rechaza el plan antes de persistirlo si hay contratos incompletos, IDs
duplicados, dependencias ausentes, auto-dependencias o ciclos. La oleada se
deriva de la profundidad del DAG y sólo representa trabajo listo.

Cada unidad avanza por tres gates:

1. `implemented`: el Implementador consolidó su reporte;
2. `validated`: el Tester aportó evidencia verde atribuible;
3. `consolidated`: la evidencia de la unidad quedó integrada en la global.

Sólo una unidad validada satisface `dependsOn`. Un reporte rojo o `fail` del
Tester deja la unidad fallida y habilita retrabajo; no la valida. Una unidad ya
validada sólo puede reabrirse con impacto explícito.

### D3. Capacidad compuesta

Se separan cuatro dimensiones:

- **presupuesto del modo:** 4 en `light`, 9 en `full`, sin el Orquestador;
- **capacidad de plataforma:** disponibilidad real del host;
- **capacidad `read-only`:** carriles de lectura permitidos;
- **aislamiento de escritores:** uno por working tree en la topología actual.

La capacidad total es `min(modo, plataforma)`. La capacidad efectiva de cada
fase incorpora además trabajo listo, topes por rol y disponibilidad separada de
lectores y writers. Ambos consumen la capacidad total, pero un writer no reduce
por sí mismo el cupo `read-only` y un lector no ocupa aislamiento de escritura.

El inicializador usa 12 para
`max_concurrent_threads_per_session` como techo técnico de Codex. Conserva
valores mayores y aclara que los workflows siguen limitados a 4/9.

### D4. Ownership y escritor único

Cada `ownedPath` writer debe ser relativa y canónica. La comparación rechaza
escapes, segmentos vacíos o `.`/`..`, colisiones exactas y relaciones de
ancestro/descendiente. Para ser portable a Windows, normaliza mayúsculas y
aliases producidos por puntos o espacios terminales en cada segmento.

El writer lock se deriva de la ruta real y canónica del working tree, no del
slug de la DevSession. Todas las DevSessions del mismo árbol comparten por tanto
una reserva. La adquisición publica por hard link un candidato completo y su
dueño exacto es `{session, attempt, workingTreeId}`.

La liberación normal y la reparación de checkpoints son estrictas: un dueño
distinto es conflicto. En un `commit` o `fail` ya terminal, repetir el mismo
payload libera sólo si el lock aún pertenece exactamente al intento. Si un
writer sucesor adquirió la reserva, el reintento idempotente devuelve éxito sin
eliminarla, modificarla ni reclamarla. Si la interrupción dejó el lock original,
la recuperación sí lo libera.

### D5. Fan-out y fan-in

El fan-out abre únicamente carriles independientes y listos. Exploración,
análisis, testing sin escritura y evaluación pueden coexistir dentro de sus
topes de rol y capacidad. Implementadores y Testers writers se serializan en el
mismo working tree. Los hilos se cierran después de consolidar para liberar
capacidad.

El fan-in comienza sólo cuando todas las unidades están validadas y
consolidadas. En `full`, dos Evaluadores `read-only` cubren Estándares y
Especificación. En `light`, un Evaluador cubre un eje combinado. Ningún eje
satisface dependencias de implementación.

### D6. Generaciones de evaluación

Cada fan-in tiene una generación. Reabrir una unidad validada incrementa la
generación e invalida todos los ejes previos. Cada eje puede reintentarse
monotónicamente dentro de la generación vigente; una consolidación tardía de un
Evaluador anterior se registra como obsoleta y no puede aprobar ni cerrar la
sesión.

`close` exige fan-in listo y todos los ejes requeridos aprobados en la
generación actual. No basta una aprobación conservada de una integración
anterior.

### D7. DevSession, upgrade y recuperación

La global persiste presupuesto, capacidades, DAG, oleadas, ownership, gates,
intentos, permisos, revisiones, hilos, criterios, evidencia, fallos, retrabajo,
generación y ejes. Cada SubDevSession contiene sólo el contrato del intento.

Una DevSession usa siempre el modelo por unidades vigente. El kernel valida
criterios, capacidades, generación y ownership antes del primer despacho; un
campo ausente o contradictorio falla de forma cerrada.

`status` y `recover` permanecen de sólo lectura. La recuperación clasifica
checkpoints y residuos sin usar antigüedad. `cleanup` elimina únicamente sobres
con acuse y evidencia coincidente.

### D8. Paridad y adapters

Política, roles, workflows, templates y controlador son canónicos en
`.agents/`. Los adapters de Codex y Claude siguen siendo punteros delgados y no
duplican topes, DAG, ownership ni generaciones. La capacidad 12 es una
optimización opcional de Codex; ninguna garantía esencial depende de ella.

## Opciones consideradas

1. **Mantener todas las fases secuenciales y sin unidades.** Reduce el estado,
   pero conserva contextos grandes, no atribuye fallos por rebanada y pierde
   revisión independiente útil.
2. **Usar toda la capacidad disponible sin modelo de ownership.** Maximiza
   concurrencia aparente, pero introduce carreras, coordinación artificial y
   evidencia difícil de consolidar.
3. **Crear un worktree por writer.** Permitiría escritores simultáneos, pero
   agrega integración Git, limpieza y autoridad que la capa actual no debe
   asumir. Puede evaluarse en una decisión futura explícita.
4. **Unidades verticales con fan-out de lectura y writer único** (elegida).
   Mejora cobertura y localidad de contexto, mantiene una frontera ejecutable
   pequeña y conserva seguridad en un checkout normal.

## Consecuencias

### Positivas

- La cobertura independiente puede crecer sin llenar cupos ni multiplicar
  writers.
- Los contextos de implementación se acotan a una unidad y cada fallo conserva
  atribución y evidencia.
- Dependencias, gates, fan-in y aprobación final dejan de depender sólo de
  disciplina textual.
- La reserva global protege también interleavings entre DevSessions y
  reintentos terminales.
- Las generaciones impiden que una evaluación obsoleta apruebe una integración
  nueva.
- Codex y Claude mantienen el mismo comportamiento observable.

### Negativas

- El ledger incorpora más estado y transiciones que una secuencia narrativa.
- Una unidad mal dividida puede costar más coordinación que contexto ahorrado;
  por eso el máximo es tres y una sola unidad sigue siendo válida.
- El writer único limita velocidad de implementación en un checkout, de forma
  deliberada.
- El fallo cerrado exige intervención cuando una sesión heredada o un lock no
  permiten probar propiedad exacta.

## Riesgos y mitigaciones

- **Confundir 12 con el límite `full`.** Documentación, mensajes y tests separan
  capacidad técnica 12 de presupuestos 4/9.
- **Dependencia satisfecha demasiado pronto.** Sólo el gate del Tester marca
  `validated`.
- **Colisión portable no detectada.** La canonicalización incluye ancestros y
  aliases Windows antes de despachar.
- **Liberar el lock del sucesor.** La identidad exacta del dueño se compara
  antes de eliminar y los terminales idempotentes preservan dueño ajeno.
- **Aprobación de generación vieja.** Los intentos y resultados de Evaluador se
  filtran por generación vigente.
- **Migración destructiva.** El upgrade es aditivo, explícito y probado como
  byte-idempotente.
- **Deriva entre hosts.** El núcleo concentra la semántica y los adapters no la
  copian.

## Validación

Los planes declaran `workUnits` y el kernel rechaza todo despacho sin el
contrato estructurado completo.

Las regresiones permanentes usan la CLI pública en procesos Node.js y
directorios temporales autolimpiables. Cubren identidad unidad/intento,
contratos y DAG, gates, dependencias, ownership portable, writer lock entre
DevSessions, capacidades separadas, fan-in por modo, generaciones, Evaluadores
obsoletos, upgrade heredado, idempotencia de `commit`/`fail`, recuperación del
lock original y preservación del lock sucesor. La validación contractual añade
checks sintácticos, suite completa, dry-run, paquete offline y auditoría de
residuos.
