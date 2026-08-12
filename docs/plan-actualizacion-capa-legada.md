# Actualización de una capa agéntica existente

## Prompt para una nueva sesión

~~~text
Orquesta en modo full la implementación descrita en
`docs/plan-actualizacion-capa-legada.md`.

Trabaja sobre el estado actual del repositorio. Hay cambios sin commit que pertenecen
al propietario: no los reviertas, no los descartes y adapta la implementación a ellos.
Respeta AGENTS.md, las políticas de `.agents/`, CodeGraph, Engram, la regla de oro y
el workflow que corresponda. No crees ni cambies de rama y no hagas commit, push,
tag, publicación ni acceso al registro sin autorización explícita.

Objetivo: añadir un subcomando `agentic update [destino]` que actualice de forma
segura una capa agéntica antigua con el inventario canónico actual, preserve los
valores rellenados por el propietario en `AGENTS.md` y ofrezca configurar en Codex
un máximo de 9 subagentes concurrentes, con elección explícita entre configuración
global, local o ninguna.

La especificación y los criterios de aceptación del documento son autoritativos.
Primero valida los supuestos contra el código y la documentación oficial vigente;
después implementa, prueba y actualiza solamente la documentación pertinente.
Si aparece una incompatibilidad real con la especificación, detente y solicita la
decisión concreta al propietario.
~~~

## Estado y restricciones conocidas

- Este documento es una especificación de traspaso; su creación no implementa el cambio.
- El árbol de trabajo ya contiene cambios del propietario, incluidos archivos nuevos de
  la regla de oro y del controlador de SubDevSessions. La implementación debe preservarlos.
- La fuente canónica de la capa está en `.agents/`; `.codex/`, `.claude/` y `CLAUDE.md`
  son adapters.
- El inicializador único está en `scripts/agentic-init.mjs`; `bin/agentic.mjs` debe
  continuar siendo un ejecutable delgado.
- La distribución no admite dependencias externas y su inventario exacto está declarado
  en `package.json`.
- El cambio no autoriza modificar Git, publicar paquetes ni acceder al registro.
- `init` debe mantener compatibilidad. El nuevo comportamiento destructivo de reemplazo
  debe exponerse mediante `update`, no convertir silenciosamente `init` en otra operación.

## Objetivo observable

Desde un proyecto que ya tenga alguna versión de la capa debe poder ejecutarse:

~~~powershell
npx --yes github:KroxiDev/agentic-layer update .
~~~

El comando debe:

1. Detectar la capa instalada, incluso si es antigua y no tiene `.agents/VERSION`.
2. Mostrar un plan completo antes de escribir.
3. Agregar los archivos canónicos nuevos.
4. Reemplazar los archivos canónicos antiguos o divergentes.
5. Eliminar residuos de versiones anteriores únicamente dentro de directorios totalmente
   administrados.
6. Preservar los hechos rellenados por el propietario en el contrato de `AGENTS.md`.
7. Preservar las instrucciones de `AGENTS.md` situadas fuera del contrato.
8. Preservar DevSessions y archivos ajenos al área administrada.
9. Ofrecer configurar 9 subagentes concurrentes en Codex a nivel global, local o no
   configurar nada.
10. Terminar de forma recuperable, sin dejar una versión marcada como actualizada tras
    una aplicación parcial.

## Interfaz CLI

### Subcomando

Agregar al ejecutable:

~~~text
agentic update [destino] [opciones]
~~~

`update` debe reutilizar el motor de detección, planificación, contrato, inventario y
validación del inicializador, evitando una segunda implementación del proceso.

### Opciones requeridas

- `--dry-run`: calcula y muestra el plan completo sin preguntar ni escribir.
- `-y`, `--yes`: omite solamente la confirmación general de archivos de la capa.
- `--codex-config global|local|none`: autorización no interactiva y explícita para la
  decisión de configuración de Codex.
- `--allow-downgrade`: permite explícitamente instalar una distribución anterior a la
  versión declarada en el destino.
- Mantener las opciones pertinentes existentes, como las acciones explícitas de
  CodeGraph, sin ampliar sus permisos.

`--yes` por sí solo nunca debe autorizar una escritura en la configuración global o
local de Codex.

### Códigos y fallos

- Si no se detecta una capa existente, `update` debe fallar sin escrituras e indicar
  `agentic init [destino]`.
- Una versión instalada superior debe bloquearse salvo `--allow-downgrade`.
- Una colisión con un enlace simbólico, directorio o ancestro inseguro debe fallar de
  forma cerrada.
- Cancelar una confirmación no debe producir escrituras parciales.
- Mantener códigos de salida coherentes con los usados actualmente para colisiones,
  cancelación y requisitos faltantes.

## Detección y comparación de versiones

1. Leer `.agents/VERSION` cuando sea un archivo regular y contenga semver válido.
2. Si falta o es antiguo, detectar la instalación mediante los marcadores de capa.
3. Clasificar el destino como `legacy-sin-version`, `anterior`, `igual` o `posterior`.
4. Permitir actualizar una capa anterior, una legacy sin versión y reparar una capa de
   la misma versión.
5. Escribir la nueva `.agents/VERSION` solamente al finalizar correctamente las
   escrituras de la capa.
6. No usar la versión como sustituto de la comparación real de archivos: una instalación
   de la misma versión puede estar incompleta o divergente.

## Política de reemplazo

En `update`, el reemplazo de la capa es el comportamiento esperado después de mostrar el
plan y recibir la confirmación general:

- Copiar rutas canónicas ausentes.
- Sobrescribir archivos canónicos regulares divergentes.
- Validar sin escribir los archivos idénticos.
- Eliminar archivos que ya no pertenezcan al inventario únicamente dentro de
  `MANAGED_DIRECTORIES`.
- Conservar `.agents/sessions/` y su contenido.
- Conservar archivos directamente bajo `.agents/` que no sean administrados, salvo el
  archivo generado `.agents/VERSION`.
- Conservar configuraciones ajenas como `.claude/settings.local.json`.
- No seguir ni reemplazar enlaces simbólicos.
- No borrar directorios con contenido no incluido expresamente en el plan.

El plan debe enumerar individualmente las copias, reemplazos y eliminaciones antes de
solicitar confirmación.

## Migración de `AGENTS.md`

`AGENTS.md` es una excepción al reemplazo canónico completo.

### Contenido que debe preservarse

- Todo el texto fuera de `AGENTIC_PROJECT_CONTRACT_START` y
  `AGENTIC_PROJECT_CONTRACT_END`, conservando su contenido y finales de línea.
- Todo valor no pendiente de un campo contractual reconocido, incluidos al menos:
  propósito, arquitectura, entrypoints, validación focalizada y completa, framework y
  ubicación de tests, ciclo de vida, estrategia Git, seguridad, documentación y ADRs.
- Valores expresados con etiquetas antiguas que estén cubiertas por alias conocidos.

### Contenido que debe actualizarse

- Estructura, secciones, texto normativo y campos suministrados por el contrato canónico
  nuevo.
- Campos incorporados en versiones nuevas.
- Valores pendientes antiguos: no deben ganar sobre una detección nueva o un valor
  predeterminado vigente.

### Compatibilidad futura

- Mantener alias para etiquetas históricas.
- Incorporar identificadores internos estables para nuevos contratos, de modo que las
  migraciones futuras no dependan solamente del texto visible de una etiqueta.
- Si existe un contrato con marcadores incompletos o duplicados, fallar sin modificarlo.
- Si una capa muy antigua no tiene marcadores contractuales, conservar `AGENTS.md`
  íntegramente y agregar el contrato nuevo; no intentar extraer campos ambiguos de prosa
  libre. Informar los campos que queden pendientes.
- Informar cualquier campo contractual antiguo que parezca administrado pero no pueda
  mapearse, para evitar pérdida silenciosa de información.

## Configuración de concurrencia de Codex

La clave canónica actual es:

~~~toml
[agents]
max_concurrent_threads_per_session = 9
~~~

La configuración admite un máximo de subagentes concurrentes sin contar el hilo
principal. La referencia oficial está en:
<https://learn.chatgpt.com/docs/config-file/config-reference>.

Codex aplica mayor precedencia a `.codex/config.toml` del proyecto que a la configuración
personal global. Referencia:
<https://learn.chatgpt.com/docs/config-file/config-basic>.

### Rutas

- Global: `$CODEX_HOME/config.toml` cuando `CODEX_HOME` esté definido; en caso contrario,
  `~/.codex/config.toml`.
- Local: `<destino>/.codex/config.toml`.

No asumir que la ruta global está dentro del sandbox o del repositorio. La selección del
usuario es autorización funcional, pero el host todavía puede exigir su propia aprobación
de filesystem.

### Inspección

1. Inspeccionar primero la clave canónica y el alias legacy `agents.max_threads` en las
   capas global y local accesibles.
2. Determinar el valor efectivo para el proyecto: el valor local gana sobre el global.
3. Si el valor efectivo es `9` o superior, no preguntar y no modificar ningún
   `config.toml`.
4. Si está ausente o es inferior a `9`, ofrecer la elección.
5. Si la estructura TOML es ambigua, contiene tablas o claves duplicadas, o no puede
   modificarse con seguridad sin un parser completo, no escribir y mostrar la edición
   manual pendiente.

La interfaz puede explicar que la capa espera un valor predeterminado de 3 y recomienda
9, pero la lógica no debe depender de que el valor implícito continúe siendo 3: una clave
ausente se trata simplemente como no configurada.

### Pregunta interactiva

Mostrar los valores detectados y preguntar:

~~~text
Codex no tiene un límite efectivo de al menos 9 subagentes para este proyecto.
La capa recomienda configurar 9 subagentes concurrentes.

¿Dónde desea configurarlo?
[g] Global: todos los proyectos (recomendado)
[l] Local: solamente este proyecto
[n] Ninguno
~~~

- Recomendar `global` por comodidad.
- Si existe una configuración local inferior a 9, recomendar `local`, porque tiene
  precedencia y una escritura global no corregiría el valor efectivo del proyecto.
- Si se selecciona `global` pese a una anulación local inferior, explicar antes de
  confirmar que el proyecto seguirá usando el valor local y dejar esa corrección como
  pendiente.
- Seleccionar `none` no cancela la actualización de la capa.

### Edición conservadora de TOML

- Crear el archivo seleccionado solamente tras autorización.
- Si existe `[agents]`, insertar o actualizar únicamente
  `max_concurrent_threads_per_session`.
- Migrar `max_threads` cuando sea inequívoco.
- Conservar todas las demás claves, secciones, comentarios, codificación y finales de
  línea.
- Si el valor seleccionado ya es 9 o superior, no reducirlo ni escribir.
- Escribir de forma atómica mediante un temporal en el mismo directorio.
- La configuración de Codex es una operación opcional posterior al éxito de la capa: un
  fallo al escribirla no debe deshacer una actualización de capa ya correcta, pero debe
  informarse claramente como pendiente.

### Modo no interactivo

- `--yes` sin `--codex-config` equivale a no autorizar la configuración y la reporta como
  pendiente.
- `--codex-config global`, `local` o `none` registra una elección explícita.
- `--dry-run` muestra qué pregunta u operación correspondería, pero no pregunta ni escribe.

## Aplicación recuperable

1. Construir y validar el plan completo antes de la primera escritura.
2. Justo antes de aplicar, comprobar que los archivos relevantes no cambiaron desde el
   plan.
3. Guardar temporalmente el contenido que será reemplazado o eliminado.
4. Aplicar las operaciones de la capa.
5. Ante un fallo intermedio, restaurar el estado previo y no actualizar `VERSION`.
6. Limpiar respaldos temporales después del éxito o de una restauración verificada.
7. Aplicar después la decisión opcional de Codex mediante escritura atómica independiente.

No dejar copias de seguridad persistentes dentro del paquete o de rutas protegidas. Git
sigue siendo la recomendación principal de recuperación para el propietario.

## Pruebas de aceptación

Agregar casos permanentes con `node:test` y directorios temporales autolimpiables para:

1. `agentic update` aparece en ayuda y se enruta desde el ejecutable delgado.
2. Un destino sin capa falla e indica `init`.
3. Una capa legacy sin `VERSION` recibe todos los archivos nuevos.
4. Una versión anterior reemplaza archivos divergentes y actualiza `VERSION`.
5. La misma versión repara archivos ausentes o divergentes.
6. Una versión posterior se bloquea, salvo autorización explícita de downgrade.
7. Los residuos administrados se eliminan y las DevSessions se conservan.
8. Los archivos ajenos fuera del área administrada se conservan.
9. Todos los campos rellenados del contrato mantienen exactamente su valor semántico.
10. Los campos nuevos aparecen y los antiguos pendientes no desplazan valores nuevos.
11. El exterior del contrato de `AGENTS.md` permanece sin cambios.
12. Marcadores contractuales malformados fallan sin escrituras.
13. Una capa sin marcadores conserva el `AGENTS.md` anterior y agrega un contrato nuevo.
14. `--dry-run` no escribe en el proyecto ni en configuración global o local.
15. Cancelar la actualización no escribe nada.
16. Un fallo intermedio restaura archivos y no actualiza `VERSION`.
17. Configuración efectiva igual a 9 o superior no pregunta ni escribe.
18. Ausencia o valor inferior ofrece global, local y none.
19. La opción global modifica solamente la clave objetivo y conserva el resto del TOML.
20. La opción local hace lo mismo en `<destino>/.codex/config.toml`.
21. Un valor superior nunca se reduce.
22. El alias `max_threads` se migra cuando es inequívoco.
23. TOML ambiguo falla de forma cerrada y produce instrucciones manuales.
24. `--yes` no autoriza configuración; `--codex-config` sí expresa la decisión.
25. Una configuración local inferior demuestra la precedencia sobre la global.
26. La suite confirma que no se agregaron dependencias ni archivos extra al paquete.

Para la configuración global, las pruebas deben inyectar un directorio personal o
`CODEX_HOME` temporal. Nunca deben leer ni escribir la configuración real del usuario.

## Archivos previstos

- `bin/agentic.mjs`: enrutar `update` y actualizar ayuda.
- `scripts/agentic-init.mjs`: separar planificación/aplicación reutilizable, migración,
  transacción y configuración de Codex.
- `tests/agentic-init.test.mjs`: fixtures legacy y pruebas anteriores.
- `README.md`: documentar `update`, elecciones de configuración y recuperación.
- `docs/arquitectura.md`: flujo de actualización y fronteras de administración.
- `.agents/README.md`: contrato interno del actualizador cuando corresponda.
- `package.json`: solamente si el inventario distribuible cambia; no añadir dependencias.

No crear un ADR por defecto. Crearlo solo si durante la implementación se toma una decisión
arquitectónica difícil de revertir que no quede explicada por esta especificación.

## Validación requerida

Validación focalizada durante el desarrollo:

~~~powershell
node --check scripts/agentic-init.mjs
node --check bin/agentic.mjs
node --test tests/agentic-init.test.mjs
~~~

Validación completa antes de entregar:

~~~powershell
node --test tests/agentic-init.test.mjs
node scripts/agentic-init.mjs --dry-run --yes
npm pack --dry-run
~~~

Además, ejecutar simulaciones de actualización solamente en directorios temporales. Nunca
probar el actualizador contra la configuración global real, el registro npm o un repositorio
de trabajo del propietario.

## Criterio de finalización

El cambio está terminado cuando el comando distribuible puede actualizar de forma
idempotente una capa legacy, incorporar el inventario actual, preservar los hechos del
proyecto, recuperar una aplicación fallida y manejar la recomendación de 9 subagentes sin
modificar ninguna configuración de Codex sin una elección explícita.
