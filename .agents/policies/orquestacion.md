# Política de orquestación

El orquestador es el único interlocutor del usuario. Selecciona el workflow,
mantiene el plan y la DevSession, delega cada fase e indexa sus reportes. Los
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

## Políticas transversales

- `.agents/policies/regla-de-oro.md`
  - Consumidores obligatorios: Planificador, Implementador, Tester y Evaluador.

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

## Decisión de activación

Esta sección es la única fuente normativa de la clasificación. Aplicar la
primera fila respaldada por hechos observables; las instrucciones explícitas del
usuario prevalecen dentro de los límites de seguridad y de las instrucciones
superiores.

| Orden | Hecho observable | Decisión |
| ---: | --- | --- |
| 1 | El usuario pide trabajar `sin orquestar`. | No activar la capa y comprobar los límites de ejecución directa. Si alguno falla, detenerse y explicar el límite concreto; no sustituir la instrucción por activación silenciosa. |
| 2 | El usuario pide `orquestar` o `full`. | Activar la capa en `full`, salvo que también elija `light` explícitamente. |
| 3 | El usuario pide `light`. | Activar la capa en `light`; nunca elegirlo automáticamente. |
| 4 | Sin instrucción explícita, existe al menos una categoría respaldada de `full` automático. | Activar la capa en `full`. |
| 5 | No existe una categoría de `full` y se cumplen todos los límites de ejecución directa verificada. | Ejecutar directamente, sin DevSession ni roles aislados. |
| 6 | Falta un hecho que cambiaría la categoría. | Consultar antes de mutar, preguntando solo por ese hecho. |

La cantidad de archivos y la mera presencia de comportamiento nuevo pueden
aportar contexto, pero nunca activan por sí solas la orquestación.

### Categorías de `full` automático

Activar `full` cuando exista al menos una señal respaldada de esta lista cerrada:

- decisión arquitectónica durable;
- seguridad, integridad, secretos o una acción difícil de revertir;
- migración o compatibilidad pública;
- varias unidades de implementación realmente independientes;
- cambio transversal cuyo ownership o fan-in sea considerable;
- bug incierto, intermitente, de rendimiento o con varias causas plausibles;
- especificación ambigua que requiera decisiones del usuario;
- concurrencia de escritores o aislamiento que la ejecución directa no pueda
  garantizar.

### Límites de ejecución directa verificada

La ejecución directa es elegible únicamente para riesgo bajo o medio cuando se
cumple todo:

- objetivo y criterios claros;
- un solo sector coherente y un solo escritor;
- cambio pequeño o mecánicamente relacionado, aunque abarque varios archivos;
- ninguna decisión arquitectónica, migración, seguridad ni compatibilidad
  pública;
- ninguna hipótesis competidora ni necesidad de fan-in;
- validación focalizada concreta disponible;
- impacto y diff revisables por el agente principal;
- contrato efectivo completo y herramientas obligatorias disponibles.

La ruta directa conserva Regla de Oro, CodeGraph, Engram, tests proporcionales,
revisión del diff y todas las restricciones de Git y seguridad. La entrega
directa debe informar por qué era elegible y qué validación focalizada ejecutó.
Si se conoce que un límite no se cumple y ninguna categoría automática aplica,
no mutar: explicar el límite y solicitar una instrucción explícita o un alcance
elegible.

Ejemplos de clasificación:

- Una corrección clara de una unidad, con test focalizado, puede abarcar varios
  archivos estrechamente relacionados y seguir siendo ejecución directa.
- Una modificación de seguridad de un solo archivo activa `full`.
- Una migración o compatibilidad pública y una decisión arquitectónica durable
  activan `full`.
- Un bug reproducible con causa directa puede usar ejecución directa; uno
  intermitente o con hipótesis competidoras activa `full`.

`Sin orquestar` nunca autoriza a omitir seguridad, integridad, acciones
restringidas ni una decisión indispensable. La duda genérica no es motivo para
preguntar: solo se consulta cuando falta un hecho que cambiaría la categoría.

## Modos

### `full`

Es el modo predeterminado dentro de una capa ya activada y el único que puede
activarse automáticamente. Conserva exploración, especificación,
implementación, testing, evaluación y documentación con profundidad
proporcional al riesgo.

### `light`

Activar únicamente cuando el usuario lo pida de forma explícita. No es un
workflow separado ni una selección de modelo. Una DevSession `light` nueva de
`feature`, `bugfix` o `refactor` persiste `lightStrategy: "compact"`; una
DevSession `light` existente sin ese campo conserva su secuencia legacy y no se
migra implícitamente. `architecture` no admite la estrategia compacta: la
petición `light` solo puede aplicarse al workflow posterior que implemente una
decisión ya aprobada.

La estrategia compacta es elegible únicamente después de una planificación
mínima que confirme todos los límites de ejecución directa verificada y,
además:

1. un único sector coherente, un solo writer y exactamente una unidad;
2. un cambio pequeño o mecánicamente relacionado;
3. una validación focalizada concreta, local y reproducible;
4. ninguna decisión pendiente del usuario;
5. ningún riesgo que active `full`, acción difícil de revertir ni cambio de
   arquitectura durable;
6. para `bugfix`, una reproducción determinista sin hipótesis competidoras.

Si una condición falla, detenerse antes de implementar y ofrecer únicamente
cambiar a `full` o reducir el alcance. Pedir `light` no autoriza a degradar
seguridad, integridad, compatibilidad, aislamiento ni evidencia.

Cada workflow elegible declara una única secuencia ejecutable mediante
`agentic-light-sequence:v1`. El controlador interpreta ese marcador solo para
sesiones `lightStrategy: "compact"`; las fases canónicas generales siguen
vigentes para `full` y para `light` legacy. El Planificador absorbe la
exploración mínima con CodeGraph, Engram y la cadena efectiva de `AGENTS.md`;
en `bugfix` consume antes la reproducción del Tester. Después intervienen el
Implementador y un Evaluador combinado independiente `read-only`. No se abre
un Tester posterior a la implementación.

El Evaluador combinado revisa el diff, comprueba Estándares y Especificación y
ejecuta o juzga la validación focalizada vigente. Su aprobación marca
atómicamente la única unidad como validada y consolidada y aprueba el eje
`combined`; `cambios requeridos` deja la unidad fallida y habilita retrabajo
atribuible. El Documentador conserva su gate condicional. No se ejecuta la
suite completa por defecto salvo que el contrato efectivo o evidencia concreta
del impacto la exijan.

## Presupuesto y paralelismo controlado

- `light` permite como máximo 4 subagentes activos.
- `full` permite como máximo 9 subagentes activos.
  El orquestador no cuenta dentro de esos topes y los valores son máximos, no
  cuotas.
- El límite efectivo de contextos de solo lectura es el mínimo entre el máximo
  del modo, la capacidad real de la plataforma y el trabajo listo. El
  aislamiento de escritores se calcula aparte y nunca reduce carriles
  `read-only`. Con menor capacidad, reducir el fan-out usando agentes reales;
  no simular agentes ni sustituirlos por procesos auxiliares.
- Topes por rol: en `light`, Explorador 2 y los demás roles 1; en `full`,
  Explorador 3, Tester 2, Evaluador 2 y los demás roles 1. Son límites de
  capacidad, no fases obligatorias; la estrategia compacta abre solo lo
  declarado por su marcador y el Documentador condicional.
- Formar oleadas deterministas únicamente con unidades listas. Cerrar cada hilo
  después de consolidar su resultado para liberar capacidad.

La planificación `full` o `light` legacy puede declarar entre una y tres
unidades de implementación, cada una con `workUnitId`, `dependsOn`,
`owned_paths`, permiso y orden. Sus dependencias solo quedan satisfechas por
validación atribuible del Tester. La estrategia compacta exige una sola unidad
writer, sin dependencias, con su validación focalizada concreta persistida. No
repetir una unidad validada salvo impacto demostrado.

Cada unidad recibe validación focalizada atribuible mediante un caso, patrón o
procedimiento concreto. El Implementador conserva una comprobación
proporcional. En `full` y `light` legacy, el Tester juzga la evidencia de cada
unidad; en `full`, después del fan-in, ejecuta además la validación completa una
sola vez antes de la evaluación final. En la estrategia compacta, el Evaluador
combinado independiente juzga o ejecuta la señal focalizada y la suite completa
continúa sin ejecutarse por defecto.

Cada intento declara su propio permiso `read-only` o `writer`; un Tester
`read-only` puede validar una unidad `writer` sin consumir aislamiento de
escritor. `baseRevision`, `threadId`, criterios, oleada y fase son obligatorios
en cada intento planificado.

Solo puede existir un solo escritor activo por working tree. Un writer lock
durable usa la identidad canónica del working tree y se comparte entre todas
sus DevSessions. Sin worktrees
aislados aprobados, Implementadores y Testers con permiso de escritura se
ejecutan secuencialmente. Cada ruta editable tiene un propietario exclusivo;
rechazar rutas no canónicas, escapes y colisiones exactas o de
ancestro/descendiente antes de despachar. La comparación es portable a Windows:
ignora mayúsculas y aliases por puntos o espacios terminales en cada segmento.

En `full` y `light` legacy, ejecutar el fan-in después de que todas las unidades
estén implementadas, validadas y consolidadas. En estrategia compacta, el
Evaluador abre sobre la única unidad `implemented` y su veredicto consolida en
una sola mutación el gate de unidad y el eje `combined`. Fuera de esa excepción,
la evaluación final usa por defecto un solo Evaluador `read-only` y un eje
combinado que cubre Estándares y Especificación, también en `full`. El
Planificador solo puede registrar `evaluationStrategy: dual` antes del fan-in
cuando `evaluationRisk` sea una de estas categorías deterministas:

- `architectural-decision`;
- `security-or-integrity`;
- `public-compatibility-or-migration`;
- `considerable-fan-in`, para varias unidades independientes cuyo fan-in tenga
  riesgo considerable.

La estrategia dual usa dos Evaluadores `read-only` independientes, uno por eje.
Sin una categoría válida, usar `evaluationStrategy: combined`. La aprobación
exige conformidad de todos los ejes requeridos por la estrategia registrada.

Cada fan-in tiene una generación. Reabrir una unidad invalida todos los ejes e
incrementa la generación; cada eje puede reintentarse de forma monotónica y
trazable. Un reporte rojo o `fail` del Tester en la ruta separada, o un veredicto
negativo del Evaluador compacto, deja la unidad no validada y habilita
retrabajo del Implementador.

## Estrategias de validación por unidad

El Planificador selecciona y registra en la especificación una estrategia para
cada unidad antes de implementar. La verifica un Tester en la ruta separada o
el Evaluador combinado en la estrategia compacta. Las estrategias admitidas
son:

1. `independent-rerun`: el verificador independiente vuelve a ejecutar la
   señal. Es la opción segura por defecto.
2. `distinct-acceptance-check`: el Implementador usa su chequeo de desarrollo y
   el verificador ejecuta una señal observable distinta de aceptación; así
   ejercitan responsabilidades distintas.
3. `verified-evidence-reuse`: el verificador puede aceptar la evidencia del
   Implementador sin repetir el mismo comando únicamente cuando la
   especificación autorizó esa reutilización antes de implementar y se cumplen
   todas estas condiciones:
   - la señal es rápida, determinista y local;
   - el reporte registra revisión base, comando o procedimiento, resultado
     exacto y criterio cubierto;
   - se conserva la misma revisión base y no hubo ningún cambio posterior en las
     rutas afectadas; el verificador revisa el diff para confirmarlo;
   - el riesgo es bajo o medio;
   - no intervienen red, tiempo real, aleatoriedad, inspección visual ni un
     entorno compartido.

La evidencia de seguridad, integridad, migración, compatibilidad pública o
concurrencia no se reutiliza. En cualquiera de esos casos, ante una condición
ausente o si la estrategia no quedó autorizada, aplicar `independent-rerun`.

Todo cambio posterior relevante invalida la reutilización. Esto incluye una
modificación en las rutas afectadas, un reintento de implementación o testing,
una dependencia reabierta o una nueva generación de fan-in: la evidencia queda
obsoleta y el verificador debe producir validación vigente. La evidencia del
Implementador nunca valida por sí sola: el Tester en la ruta separada o el
Evaluador combinado en compacto revisa el diff, juzga la cobertura y produce el
reporte atribuible que puede marcar la unidad.

Estas estrategias afectan únicamente la validación focalizada de una unidad.
En `full`, la validación completa sigue ejecutándose una sola vez después del
fan-in y antes de la evaluación final.

## Gate condicional de Documentador

En el cierre de `feature`, `bugfix` y `refactor`, después de la evaluación
aprobada, abrir Documentador solo cuando exista al menos una entrada real:

- el cambio vuelve incorrecta o incompleta documentación vigente; todo cambio
  de interfaz pública exige revisar y reflejar su contrato;
- el contrato efectivo exige actualizar un artefacto;
- existe una decisión durable que debe registrarse;
- existe un candidato validado que merece Engram y no fue consolidado por otro
  responsable autorizado.

Un cambio de interfaz pública o una decisión durable sigue exigiendo
Documentador. Cuando ninguna condición aplica, registrar `No aplica` con un
motivo breve en la DevSession y no abrir ni crear un contexto de Documentador.
Este gate es condicional por evidencia y riesgo, no opcional por comodidad.
No altera `architecture-propose` ni `architecture-record`, cuyas fases registran
una propuesta o decisión durable según su workflow específico.

En la ruta separada, el orden de cierre se conserva: fan-in, validación completa
única en `full`, evaluación y Documentador condicional. En compacto, la
aprobación combinada produce fan-in y evaluación atómicos antes del mismo gate
documental.

## Selección de workflow

| Intención | Workflow |
| --- | --- |
| Funcionalidad o cambio de comportamiento | `workflows/feature.md` |
| Bug o regresión | `workflows/bugfix.md` |
| Reestructura sin cambio de comportamiento | `workflows/refactor.md` |
| Decisión de diseño durable | `workflows/architecture.md` |

Si ninguna categoría encaja con claridad, consultar al usuario. No elegir una
por descarte silencioso.

Una tarea exclusivamente arquitectónica termina después de explorar, comparar,
obtener aprobación explícita y registrar la decisión. Si la decisión aprobada
debe implementarse, cerrar `architecture` y transferirla una sola vez a
`feature` o `refactor` como restricción y criterio de aceptación. Ese workflow
posterior es el único responsable de implementar, testear, evaluar y documentar
el resultado final; `architecture` no repite ese cierre.

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

El orquestador administra el ciclo con
`node .agents/scripts/session-controller.mjs <comando> --session <slug>` y una
revisión esperada en cada mutación. Usa `init`, `open`, `await-input`, `resume`,
`commit`, `fail`, `recover`, `cleanup` y `close` según la transición requerida.
El primer `init` persiste modo y capacidades y aplica desde entonces los topes,
aunque el DAG todavía no exista. Para una sesión `light` nueva también persiste
`lightStrategy: "compact"`; la ausencia del campo en una sesión existente se
interpreta como legacy y nunca se completa por inferencia.
Tras planificar unidades, repetir `init` con la revisión vigente para registrar
atómicamente el DAG y la capacidad detectada antes de abrir sus intentos.

`commit` conserva el cuerpo íntegro del reporte contractual únicamente en la
SubDevSession. La parte humana global recibe una referencia compacta con sesión,
intento, fase, rol, unidad o eje aplicable, estado, resultado, hash y ruta; el
bloque administrado global continúa siendo la fuente del estado de coordinación.
`status` usa ese bloque y no carga cuerpos de reportes. Las consolidaciones
verbosas heredadas permanecen legibles y no se reescriben.

Actualizarla al cerrar cada fase. Es el único traspaso de estado entre
subagentes y debe registrar:

- objetivo, workflow, modo, estrategia light cuando aplique y fase actual;
- presupuesto del modo, capacidad `read-only`, aislamiento de escritores y oleada;
- unidades, dependencias, ownership, permiso por intento, hilos y revisión base;
- estrategia de validación por unidad y, si se reutiliza evidencia, revisión,
  comando o procedimiento, resultado, criterio cubierto y vigencia;
- estados implementada, validada y consolidada, con evidencia atribuible;
- hilos abiertos/cerrados, fallos, retrabajo y resultado del fan-in;
- validación focalizada por unidad y validación completa única posterior al
  fan-in cuando corresponda;
- estrategia, riesgo registrado, generación y ejes de evaluación final con sus
  veredictos;
- sector de importancia y reglas efectivas por sector;
- especificación, tareas y decisiones;
- archivos modificados;
- tests creados, separados entre temporales y permanentes;
- comandos y resultados de validación;
- veredicto del evaluador;
- decisión del gate de Documentador o `No aplica` con su motivo;
- candidatos a memoria y próximos pasos.

Antes de abrir cada Evaluador o el Documentador final, el orquestador debe
seleccionar explícitamente en el índice los sobres pertinentes y pasar sus rutas,
no el historial completo. Para el Evaluador de la ruta separada, la selección se
limita a los intentos de implementación y testing de las unidades del fan-in y
a la generación o eje vigente; para el Evaluador compacto, al intento vigente
del Implementador y la evidencia focalizada de su única unidad. Para el
Documentador, se limita a decisiones, cambios, validación y evaluaciones
aprobadas que condicionen la documentación. Ambos consumos deben terminar antes
de `cleanup`.

No versionar instancias reales. Los inventarios y el paquete las excluyen
aunque existan durante la validación. Eliminarlas al cerrar correctamente la
tarea.

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
Implementador con la lista accionable y luego repetir la validación independiente
y la evaluación que correspondan a la ruta. Permitir como máximo dos ciclos de
retrabajo. Si persiste el rechazo, detenerse y presentar el diagnóstico al
usuario.

## Engram

- Verificar la identidad del proyecto antes de leer o escribir memoria.
- Usar ámbito de proyecto por defecto. El ámbito personal o global requiere
  autorización explícita.
- Explorador y Planificador consultan historial relevante con una pregunta
  concreta; en estrategia compacta esa responsabilidad recae en el
  Planificador. Otros roles consultan solo cuando una decisión previa condiciona
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
3. Repetir únicamente la validación afectada por la limpieza. Repetir la suite
   completa solo ante evidencia concreta de impacto transversal.
4. Evaluar el gate condicional de Documentador. Si existe una entrada real,
   abrirlo con la selección explícita de sobres pertinente; en caso contrario,
   registrar `No aplica` con su motivo sin crear ese contexto.
5. Confirmar que Evaluador y, cuando se abrió, Documentador ya consumieron sus
   sobres y ejecutar `cleanup`.
6. Consolidar en Engram los candidatos durables.
7. Ejecutar `close` para eliminar la DevSession.
8. Informar cambios, evidencia, límites y próximos pasos al usuario.
