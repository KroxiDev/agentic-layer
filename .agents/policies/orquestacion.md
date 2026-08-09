# Política de orquestación

El orquestador es el único interlocutor del usuario. Selecciona el workflow,
mantiene el plan y la DevSession, delega cada fase y consolida los reportes. Los
roles no hablan con el usuario ni se coordinan entre sí.

## Precedencia y reglas efectivas

Aplicar, en este orden:

1. instrucciones de la plataforma y del usuario;
2. reglas globales del `AGENTS.md` raíz;
3. overrides del `AGENTS.md` más cercano a cada sector afectado;
4. políticas genéricas de `.agents/`;
5. instrucciones técnicas del adapter.

Acumular todas las restricciones de seguridad y conservar la más estricta. Si
dos reglas no relacionadas con seguridad son irreconciliables, detener la
implementación y presentar la contradicción al usuario.

El Explorador debe resolver explícitamente, para cada sector, la cadena de
archivos `AGENTS.md` desde la raíz hasta el archivo local más cercano. Un
archivo local puede redefinir arquitectura, validación, tests y documentación
de su sector, pero no debilitar seguridad, requisitos de herramientas ni
orquestación global. Para una tarea que cruza sectores, acumular validaciones
compatibles y consultar los conflictos.

## Preflight obligatorio

Al activar una tarea orquestada, realizar una sola comprobación mínima y
silenciosa antes de crear la DevSession:

1. CodeGraph está disponible y responde una consulta mínima sobre el
   repositorio actual.
2. Engram está disponible e identifica sin ambigüedad el repositorio actual.
3. La plataforma puede crear los subagentes aislados requeridos.
4. El contrato efectivo de `AGENTS.md` está completo.

No incorporar al contexto salidas extensas del preflight. Si una comprobación
falla, detenerse y mostrar únicamente el diagnóstico breve necesario. No usar
grep, lecturas exploratorias, memoria improvisada, ejecución secuencial,
subinvocaciones de CLI ni otro proceso degradado como sustituto.

<!-- STRICT_PROJECT_CONTRACT_RULE_START -->
## Regla estricta: contrato incompleto

El `AGENTS.md` raíz debe incluir valores explícitos, o `No aplica`, para
Proyecto, Validación, Tests, Git, Seguridad y Documentación. Un placeholder, un
campo vacío o una sección ausente cuenta como incompleto. Un `AGENTS.md` local
puede omitir lo que hereda, pero todo override que declare debe tener un valor
explícito.

Seguridad debe declarar `Contaminación de origen` como un corpus reproducible o
como `No aplica` con justificación. Un scan sin corpus cuando existe un
repositorio de extracción cuenta como contrato incompleto.

Si falta un campo obligatorio, no iniciar la implementación. Informar la ruta
del archivo, la sección y el campo exactos; no inferirlos ni completarlos
automáticamente. El usuario debe corregir `AGENTS.md` antes de continuar.
<!-- STRICT_PROJECT_CONTRACT_RULE_END -->

## Activación

- Activar siempre cuando el usuario pida `orquestar`.
- Activar automáticamente en `full` para tareas no triviales: cambios
  multiarchivo, comportamiento nuevo, bugs no triviales, refactors con impacto
  o decisiones arquitectónicas.
- Resolver directamente una tarea trivial, local y evidente.
- Si la clasificación es dudosa, preguntar antes de actuar.
- No activar `light` automáticamente.

## Modos

### `full`

Es el modo predeterminado y el único que puede activarse automáticamente.
Conserva exploración, especificación, implementación, testing, evaluación y
documentación con profundidad proporcional al riesgo.

### `light`

Activar únicamente cuando el usuario lo pida de forma explícita. No es un
workflow separado ni una selección de modelo: modifica la intensidad de
implementación y testing en feature, bugfix y refactor. En architecture solo
puede modificar el workflow posterior que implemente una decisión aprobada.

Conservar en `light` los mismos roles, workflow, contextos aislados,
DevSession, revisión del diff, evidencia de validación y restricciones de
seguridad e integridad. Reducir:

- el cambio al mínimo estrictamente acotado;
- TDD y tests nuevos, que no se usan por defecto;
- la suite completa, que no se ejecuta por defecto;
- refactors, abstracciones y documentación no imprescindibles;
- la validación a evidencia focalizada y proporcional.

El Tester debe indicar qué validó, cómo lo validó y qué omitió por tratarse de
`light`. Puede usar inspección del diff, una validación estática focalizada, un
test existente relacionado, un smoke test o inspección visual, de accesibilidad
y responsividad cuando el cambio lo requiera.

Si el impacto parece considerable, el orquestador debe advertir:

~~~text
Esta tarea podría exceder el alcance recomendado para `light`:

1. <razón real>
2. <razón real adicional, si existe>

Recomiendo usar `full`. ¿Quieres cambiar a `full` o continuar en `light` con
validación reducida?
~~~

La decisión del usuario no permite ignorar seguridad, integridad, acciones
destructivas, reglas obligatorias ni instrucciones superiores.

## Selección de workflow

| Intención | Workflow |
| --- | --- |
| Funcionalidad o cambio de comportamiento | `workflows/feature.md` |
| Bug o regresión | `workflows/bugfix.md` |
| Reestructura sin cambio de comportamiento | `workflows/refactor.md` |
| Decisión de diseño durable | `workflows/architecture.md` |

Si ninguna categoría encaja con claridad, consultar al usuario. No elegir una
por descarte silencioso.

## Delegación aislada

Cada fase se ejecuta en un subagente o contexto nativo aislado. El subagente
recibe únicamente el objetivo, la DevSession, las reglas efectivas y los
artefactos necesarios, y devuelve solo el contrato de salida de su rol.

Los subagentes:

- no hablan con el usuario;
- no se coordinan entre sí;
- no amplían el alcance;
- heredan modelo, nivel de razonamiento, permisos, aprobaciones y herramientas
  de la sesión principal, salvo una restricción técnica más estricta del rol.

El orquestador presenta preguntas y advertencias, mantiene el plan, actualiza la
DevSession y decide la fase siguiente. Si la plataforma no puede crear
subagentes, se detiene. No adopta roles secuencialmente ni lanza procesos de
agente por shell.

Evitar escrituras concurrentes sobre el mismo working tree. Implementación,
testing y documentación se ejecutan en el orden del workflow.

## Prioridad de Codex y paridad

Usar Codex como primera superficie de diseño y validación de la capa. Mantener
el núcleo en el denominador común con Claude Code: ambos adapters deben exponer
los mismos roles, workflows, contratos y garantías observables. Una
optimización exclusiva de Codex debe ser opcional y ninguna capacidad esencial
puede depender de ella.

## DevSession

Después del preflight, crear una instancia a partir de
`templates/dev-session.md` en `.agents/sessions/<slug>.md`. Usar el mismo
formato en `full` y `light`; completar proporcionalmente y usar `No aplica`
cuando corresponda.

Actualizarla al cerrar cada fase. Es el único traspaso de estado entre
subagentes y debe registrar:

- objetivo, workflow, modo y fase actual;
- sector de importancia y reglas efectivas por sector;
- especificación, tareas y decisiones;
- archivos modificados;
- tests creados, separados entre temporales y permanentes;
- comandos y resultados de validación;
- veredicto del evaluador;
- candidatos a memoria y próximos pasos.

No versionar instancias reales. Eliminarlas al cerrar correctamente la tarea.

## Relevo de preguntas

Cuando el Planificador active `agentic-grilling`:

1. recibir su ronda completa de preguntas;
2. presentarla al usuario sin reformularla;
3. devolver las respuestas al mismo contexto del Planificador cuando la
   plataforma permita continuarlo;
4. actualizar la especificación y recalcular la siguiente frontera.

Solo el orquestador conversa con el usuario.

## Ciclo Evaluador → Implementador

Si el Evaluador devuelve `cambios requeridos`, iniciar un nuevo subagente
Implementador con la lista accionable y luego repetir testing y evaluación.
Permitir como máximo dos ciclos de retrabajo. Si persiste el rechazo, detenerse
y presentar el diagnóstico al usuario.

## Engram

- Verificar la identidad del proyecto antes de leer o escribir memoria.
- Usar ámbito de proyecto por defecto. El ámbito personal o global requiere
  autorización explícita.
- Explorador y Planificador consultan historial relevante con una pregunta
  concreta. Otros roles consultan solo cuando una decisión previa condiciona
  su fase.
- Cualquier rol puede devolver un candidato a memoria.
- El Evaluador puede guardar directamente un error, riesgo o hallazgo crítico
  respaldado por evidencia.
- El orquestador o Documentador consolida los demás candidatos al cierre.
- Guardar solo información validada, no obvia, reusable y accionable. No
  guardar logs, hipótesis descartadas, auditorías no confirmadas ni el contenido
  transitorio de la DevSession.

## Cierre

1. Exigir veredicto `aprobado`.
2. Eliminar únicamente tests creados en esta DevSession, marcados como
   temporales y cuya eliminación permita el contrato efectivo. Nunca eliminar
   tests preexistentes.
3. Repetir la validación pertinente después de la limpieza.
4. Ejecutar la fase de Documentador, aunque concluya sin cambios.
5. Consolidar en Engram los candidatos durables.
6. Eliminar la DevSession.
7. Informar cambios, evidencia, límites y próximos pasos al usuario.
