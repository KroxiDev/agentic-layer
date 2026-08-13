# Adopción por copia, sin dependencia ni sincronización

La capa se adopta copiando su inventario canónico al proyecto: `npx` ejecuta
`init` o `update` solo por orden explícita y no queda ningún vínculo posterior.
Decidimos que el
proyecto adoptante **no** declare la plantilla como dependencia, no la referencie
como submodule o subtree y no reciba actualizaciones automáticas, porque la capa
es texto que cada propietario debe poder editar, y una actualización silenciosa
de las reglas del proceso es un cambio de comportamiento del equipo, no un
parche.

## Opciones consideradas

- **Dependencia npm declarada.** Daría `npm update`, pero convierte el proceso en
  un artefacto de `node_modules/` que el propietario no puede editar y obliga a
  todo proyecto adoptante a tener un ecosistema Node.
- **Git submodule o subtree.** Conserva historial y permite `pull`, a cambio de
  fricción permanente en cada clon y de acoplar la estrategia Git del adoptante
  a la de la plantilla, que el contrato declara como decisión del propietario.
- **Copia con actualización explícita** (elegida). `agentic update` revalida,
  informa el plan y aplica el reemplazo solicitado de forma recuperable.

## Consecuencias

Actualizar es ejecutar `agentic update`: los archivos idénticos se validan, los
ausentes se copian y los divergentes se enumeran antes del reemplazo. Reemplazar
pierde las modificaciones locales de los archivos canónicos listados, pero
conserva el seam contractual, las DevSessions y los archivos ajenos. No existe
forma de saber si una capa instalada está al día sin ejecutar el comando, y de
ahí que exista `.agents/VERSION` como única marca de la versión adoptada.
