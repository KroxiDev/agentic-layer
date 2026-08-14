---
name: orquestar
description: Orquesta tareas de desarrollo mediante roles aislados, DevSession y workflows full o light. Usar cuando el usuario pida orquestar o cuando la política canónica clasifique una señal cerrada de full automático; light requiere petición explícita.
---

# Orquestar

1. Leer `AGENTS.md` y `.agents/policies/orquestacion.md`.
2. Confirmar que la decisión canónica activó la capa y ejecutar el preflight
   obligatorio; detenerse si falla un requisito.
3. Seleccionar el workflow; dentro de la capa usar `full` por defecto y `light`
   solo por petición explícita.
4. Crear o adoptar la DevSession y administrar sus sobres con
   `.agents/scripts/session-controller.mjs`, usando la revisión esperada en cada
   mutación. Registrar modo y capacidades desde el primer `init`.
5. Leer el workflow elegido en `.agents/workflows/`.
6. Pedir al Planificador un DAG de una a tres unidades con dependencias,
   propiedad exclusiva, permiso y estrategia de validación por unidad según la
   política canónica. Registrar el plan con `init` y calcular el fan-out
   `read-only` como el mínimo entre modo, plataforma y trabajo listo; calcular
   aparte el aislamiento de escritores. Registrar
   `evaluationStrategy: combined` por defecto; usar `dual` únicamente con una
   categoría `evaluationRisk` admitida y explícita antes del fan-in.
7. Despachar las oleadas con agentes reales en contextos aislados. Priorizar
   carriles de solo lectura y mantener un writer lock compartido por la identidad
   canónica del working tree. Cada intento declara permiso, `baseRevision`,
   `threadId` y criterios. Cerrar cada hilo después de consolidar su resultado.
8. Registrar el reporte contractual mediante `commit`: el cuerpo íntegro queda
   solo en la SubDevSession y la global conserva su referencia compacta en el
   índice y su estado en el bloque administrado. Usar `await-input` y `resume`
   para relevar preguntas o aprobaciones.
9. Testear cada unidad con la estrategia y evidencia focalizada concretas
   registradas. El Tester aplica las condiciones canónicas, revisa el diff y
   decide si vuelve a ejecutar, usa una señal distinta o acepta evidencia
   vigente; solo su validación atribuible satisface dependencias. Un reporte rojo
   o `fail` habilita retrabajo sin validar. Después de consolidar todas las
   unidades, ejecutar el fan-in y, en `full`, una sola validación completa antes
   de evaluar.
10. Abrir por defecto un Evaluador `read-only` que cubra conjuntamente
    Estándares y Especificación, incluso en `full`. Solo con estrategia dual y
    riesgo registrado abrir dos Evaluadores independientes. Antes de cada
    apertura, seleccionar explícitamente en el índice y pasar solo las rutas de
    los sobres de implementación y testing de las unidades del fan-in, la
    generación y el eje vigentes. Aplicar el límite de dos ciclos Evaluador →
    Implementador. Versionar cada fan-in, invalidar sus ejes al reabrir una
    unidad y permitir reintentos trazables por eje.
11. Cerrar según la política: limpiar únicamente tests temporales autorizados y
    repetir únicamente la validación afectada por esa limpieza. Evaluar el gate
    de Documentador: abrirlo y pasarle solo los sobres pertinentes cuando exista
    trabajo documental o memoria durable; si no, registrar `No aplica` con su
    motivo sin crear el contexto. Consolidar Engram y ejecutar `cleanup`
    únicamente después de que Evaluador y, si se abrió, Documentador hayan
    consumido sus sobres; después ejecutar `close`.

En `architecture`, terminar después de registrar la decisión aprobada cuando no
haya implementación. Si debe implementarse, cerrar ese workflow y transferir la
decisión una sola vez a `feature` o `refactor`; no volver a evaluar ni documentar
en `architecture` lo que el workflow posterior ya cerró.

No ejecutar roles secuencialmente en el hilo del orquestador ni sustituir
subagentes con procesos de CLI.
