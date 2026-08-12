# Controlador portable para DevSession global y SubDevSessions efímeras

**Estado: Aceptada**

## Contexto y problema

La orquestación actual usa una única DevSession compartida como estado durable y
como traspaso entre fases. Ese modelo conserva el contexto global, pero no
identifica de forma comprobable cada ejecución de fase, rol e intento, no limita
el contexto entregado a cada subagente y no deja un protocolo ejecutable para
consolidar un reporte, acusar su recepción, recuperar una interrupción o limpiar
un residuo sin perder estado.

La capa tampoco tiene un runtime de orquestación. Los roles y workflows son
contratos declarativos, y los adapters de Codex y Claude deben seguir siendo
delgados. Resolver los casos reales de interrupción, recuperación y limpieza
requiere una superficie ejecutable acotada, pero no justifica introducir un
runtime que cree agentes, gestione hilos o replique las decisiones semánticas
del orquestador.

Existe además un conflicto en la validación actual:
`validateTemplateDistribution()` rechaza entradas reales en
`.agents/sessions/` distintas de `gitignore.asset`, mientras el workflow exige
mantener la DevSession activa hasta después de validación, evaluación y
documentación. La validación completa previa al cierre y el ciclo de vida de la
DevSession no pueden cumplirse simultáneamente en el mismo checkout. La solución
debe permitir sesiones reales ignoradas durante una tarea y, a la vez,
garantizar que no entren en los inventarios ni en el paquete distribuido.

## Fuerzas y principios obligatorios

La decisión debe conservar estas propiedades:

1. La DevSession global es la única fuente de verdad durable durante la tarea.
2. Las SubDevSessions son sobres temporales, no fuentes de estado
   independientes.
3. La especificación, las decisiones globales y el historial completo no se
   duplican en cada sobre.
4. Toda instrucción nueva del usuario se registra en la global antes de crear
   otra SubDevSession.
5. Ningún hilo se cierra ni ningún sobre se elimina antes de recibir,
   consolidar y comprobar el reporte contractual.
6. Un hilo permanece abierto sólo cuando la fase actual necesita follow-up.
7. Una fase terminada no se reactiva; el retrabajo crea agente, sobre e intento
   nuevos.
8. El agente de retrabajo continúa desde el estado consolidado, sin depender
   del hilo anterior ni repetir contexto innecesario.
9. Implementación, testing y documentación mantienen el orden del workflow.
10. El cierre normal elimina correctamente SubDevSessions y DevSession global.

También son fuerzas de diseño la portabilidad entre Codex y Claude, cero
dependencias externas, operaciones recuperables e idempotentes, fallo cerrado
ante ambigüedad y pruebas del comportamiento público con procesos reales.

## Decisión

Adoptar un controlador Node.js mínimo, portable y distribuido que administre el
ciclo de vida persistido de la DevSession global y sus SubDevSessions. La
implementación canónica vive en
`.agents/scripts/session-controller.mjs` y ambos hosts la invocan directamente
con Node.js.

El controlador valida identidades, contratos y transiciones; administra el
bloque de estado, hashes y acuses; clasifica residuos; y ejecuta operaciones de
recuperación y limpieza. No crea agentes, no conversa con el usuario, no decide
el consolidado semántico, no gestiona hilos ni sus identificadores privados y no
sustituye al orquestador.

Las decisiones P1-P10 siguientes forman parte de la arquitectura aceptada.

### P1. Frontera ejecutable

Se elige el controlador mínimo portable. Aporta comprobación real del ciclo de
sesiones sin convertir la capa en un runtime completo de orquestación. Su
responsabilidad termina en el estado persistido y en las transiciones que el
orquestador solicita explícitamente.

### P2. Ubicación e invocación

El controlador es canónico y distribuido en
`.agents/scripts/session-controller.mjs`. Codex y Claude lo ejecutan
directamente con Node.js; los adapters sólo referencian el contrato común y no
contienen implementaciones alternativas.

### P3. Topología y almacenamiento

La DevSession global permanece en `.agents/sessions/<slug>.md`. Sus sobres
efímeros viven en `.agents/sessions/<slug>/<identidad>.md`. El controlador
administra bloques JSON delimitados y versionados dentro de los archivos
Markdown; no existe base de datos, servicio de bloqueo ni sidecar durable.

La global contiene instrucciones, reglas efectivas, especificación, decisiones,
estado consolidado, evidencia y retrabajo. Cada sobre contiene únicamente el
contexto necesario para su ejecución, el reporte temporal y su bloque JSON; no
replica la global.

### P4. Identidad de fase, rol e intento

Cada sobre usa `<phase-id>--<rol>--a<NN>.md` y declara al menos
`sessionSlug`, `workflow`, `phaseId`, `role` y `attempt`. Los workflows declaran
identificadores de fase estables. El intento es monotónico por fase y nunca se
reutiliza, incluso después de fallo o limpieza. Una colisión o una contradicción
entre ruta, metadatos y ledger falla sin sobrescribir datos.

### P5. Reporte, consolidación y acuse

El orquestador decide el consolidado semántico. El controlador valida el reporte
final contra el contrato del rol, incorpora de forma idempotente la sección
administrada en la global, registra los hashes pertinentes y marca el intento
como `consolidated`. Una consolidación idéntica no duplica contenido; una
consolidación divergente para el mismo intento se rechaza.

Después de comprobar el consolidado se registra un acuse durable. Sólo entonces
pueden cerrarse el hilo y el sobre. Esta operación transaccional puede
denominarse `commit` dentro del protocolo, pero no crea un commit de Git.

### P6. Fallo y recuperación

`recover` informa el estado y nunca elimina por antigüedad. Si el hilo sigue
vivo, el mismo intento continúa. Si el hilo se perdió, el orquestador registra
la causa; el controlador consolida un fallo diferenciado, acusa el cierre y
habilita un intento nuevo que parte exclusivamente del estado global
consolidado.

Las operaciones mutantes son idempotentes y una interrupción debe dejar un
estado reconocible y recuperable. La recuperación distingue continuidad de un
fallo explícito; no transforma silenciosamente uno en otro.

### P7. Compatibilidad y migración perezosa

Las DevSessions Markdown existentes se adoptan in situ. `status` es siempre de
sólo lectura. La primera operación mutante agrega el bloque administrado sin
reescribir el contenido humano existente. Marcadores o JSON inválidos,
identidades contradictorias, colisiones y revisiones obsoletas detienen la
operación sin sobrescribir.

### P8. Follow-up, estados e inmutabilidad

Un pedido de información, incluido grilling, lleva el intento a
`awaiting_input`. `resume` conserva el mismo intento y sólo procede si la
DevSession global cambió desde esa espera. Un único reporte final avanza por
`reported`, `consolidated` y el cierre con acuse.

Los intentos `completed` o `failed` son inmutables. Cualquier retrabajo permitido
crea un intento, agente y SubDevSession nuevos y registra su causa y el intento
anterior. El controlador no reactiva una fase terminada.

### P9. Huérfanas, limpieza y cierre global

`status` clasifica sin mutar cada residuo como `safe_to_delete`, `recoverable` o
`ambiguous`. `cleanup` elimina únicamente `safe_to_delete`, lo que exige acuse
durable y hashes coincidentes. La edad del archivo no autoriza ninguna
eliminación.

El cierre de la tarea rechaza sobres abiertos, recuperables o ambiguos. La
DevSession global se elimina sólo después de un cierre correcto conforme al
workflow.

### P10. Contrato único de los roles

La sección `## Salida` de cada rol canónico es la única fuente del contrato de
reporte. Sus campos se normalizan como viñetas etiquetadas e interpretables, y
el controlador deriva de esa fuente la validación; no se introduce un
manifiesto paralelo. Un reporte incompleto falla cerrado. El grilling se modela
como `awaiting_input`, no como un reporte final.

## Garantías de paridad, distribución y pruebas

El núcleo, los estados y las garantías observables son comunes a Codex y Claude.
Ninguna capacidad esencial depende de APIs privadas, continuidad de hilos o una
optimización exclusiva de un host. Los adapters continúan siendo punteros
delgados.

El controlador, los templates global y de SubDevSession, las políticas, los
roles y los workflows necesarios forman parte del inventario distribuido.
`TEMPLATE_FILES`, `PACKAGE_FILES` y `package.json.files` deben permanecer
alineados. Las sesiones reales ignoradas pueden existir durante la validación
del checkout, pero quedan fuera de los inventarios y del paquete.

Las pruebas nuevas son permanentes, usan `node:test`, ejecutan la CLI pública en
procesos Node.js separados y trabajan sólo en directorios temporales
autolimpiables. Deben cubrir como mínimo:

- creación global y adopción legacy preservando Markdown;
- marcadores y JSON inválidos, identidad, colisiones, monotonicidad y revisión
  obsoleta;
- follow-up, `resume`, contrato incompleto y estados terminales inmutables;
- consolidación idéntica y divergente, hashes, acuse y rechazo de cierre
  prematuro;
- interrupción, recuperación, fallo sin reporte y retrabajo con intento nuevo;
- las tres clases de residuos, limpieza segura y cierre global;
- paridad entre adapters, adopción distribuida, validación con sesión activa y
  exclusión de sesiones reales del paquete.

La validación focalizada incluye `node --check` del controlador, del
inicializador y del ejecutable, más el caso relacionado de la suite. La
validación completa ejecuta la suite, el dry-run del inicializador con una
DevSession activa y `npm pack --dry-run`; después de la limpieza se repite la
validación pertinente.

## Opciones consideradas

1. **Protocolo declarativo sin runtime.** Es el cambio más pequeño y portable,
   pero no puede probar literalmente interrupciones, consolidación, acuse,
   recuperación ni limpieza reales; deja garantías centrales a disciplina
   manual.
2. **Controlador Node.js mínimo y portable** (elegida). Hace ejecutable y
   comprobable el ciclo de sesiones con la biblioteca estándar, manteniendo en
   el orquestador la creación de agentes y las decisiones semánticas. Añade una
   superficie CLI y estado administrado que deben diseñarse y probarse.
3. **Runtime completo con adapters por host.** Podría automatizar agentes e
   hilos, pero amplía sustancialmente el producto, se acopla a capacidades
   privadas de cada plataforma y vuelve más difícil sostener la paridad.

## Consecuencias

### Positivas

- La global sigue siendo la única fuente durable y cada subagente recibe un
  contexto mínimo y trazable.
- Consolidación, acuse, fallo, recuperación y limpieza pasan a tener evidencia
  mecánica e idempotente.
- Un retrabajo puede continuar con un agente nuevo sin depender del hilo
  anterior.
- Las sesiones activas dejan de ser incompatibles con la validación
  estructural sin exponerse en la distribución.
- Codex y Claude comparten la misma implementación y las mismas garantías.

### Negativas

- Se incorpora una nueva CLI pública, un formato JSON versionado y un ledger
  cuyo contrato deberá mantenerse compatible.
- Roles, workflows, políticas, templates, adapters, inventarios, validación,
  documentación y pruebas deberán cambiar de forma coordinada.
- Derivar contratos desde Markdown vuelve estable e interpretable la forma de
  `## Salida`; modificarla deja de ser un cambio puramente editorial.
- El fallo cerrado puede requerir intervención manual ante archivos legacy
  ambiguos, corrupción, colisiones o residuos sin evidencia suficiente.

## Riesgos y mitigaciones

- **Doble fuente de verdad.** Se evita limitando los sobres a contexto mínimo y
  reporte temporal; el ledger y el consolidado autoritativos viven en la
  global.
- **Borrado prematuro o pérdida de reporte.** El acuse durable y los hashes
  coincidentes preceden a `cleanup`; los casos recuperables o ambiguos no se
  eliminan.
- **Reejecución tras interrupción.** Las mutaciones son idempotentes, las
  revisiones obsoletas se rechazan y `recover` expone el estado reconocible.
- **Deriva entre hosts o distribución incompleta.** Una implementación canónica,
  adapters delgados, inventarios exactos y pruebas de adopción sostienen la
  paridad.
- **Expansión hacia un runtime completo.** Los límites excluyen gestión de
  agentes, hilos, daemon, expiración, base de datos, bloqueo externo y APIs
  privadas.

## Compatibilidad, migración y adopción

La adopción es perezosa y conserva las DevSessions Markdown existentes. No hay
migración masiva: `status` puede inspeccionarlas sin escribir y la primera
mutación agrega estado administrado sólo cuando la identidad y los marcadores
son inequívocos. El formato JSON es delimitado y versionado para permitir
evolución explícita. Los intentos ya cerrados no se reinterpretan ni reabren.

El cambio afecta comportamiento público. La ADR fue aprobada explícitamente por
el propietario e implementada mediante el workflow `feature` en modo `full`,
con TDD por rebanadas y pruebas reales. La verificación final confirmó 3/3
checks sintácticos, 13/13 casos focalizados, 41/41 casos de la suite completa y
un paquete offline de 46 archivos sin sesiones ni residuos efímeros.
