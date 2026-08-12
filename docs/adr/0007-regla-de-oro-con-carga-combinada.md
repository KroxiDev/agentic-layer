# La Regla de Oro vive en una política independiente con carga combinada

**Estado: Aceptada**

La Regla de Oro para escribir código y pruebas es transversal: condiciona la
planificación, la implementación, la verificación y la evaluación, exista o no
un ciclo TDD. Además, una política bajo `.agents/policies/` no se consume por el
mero hecho de existir. Necesita una fuente normativa única y referencias
explícitas que hagan auditable su carga sin copiar su contenido.

## Decisión

La definición canónica vive únicamente en
`.agents/policies/regla-de-oro.md`. `AGENTS.md` la activa para tareas directas y
orquestadas; `.agents/policies/orquestacion.md` mantiene el registro central de
consumidores, y los roles Planificador, Implementador, Tester y Evaluador
incluyen un enlace operativo a la política para aplicarla durante su fase.

El archivo forma parte de `TEMPLATE_FILES` y de `package.json.files`. La
validación estructural comprueba su presencia y las referencias de los cuatro
consumidores, y una simulación de adopción comprueba que la política llega al
proyecto de destino. Los adapters conservan su función de punteros delgados y no
duplican la política.

## Opciones consideradas

- **Ampliar `.agents/policies/sdd-tdd.md`.** Evita un archivo adicional, pero
  mezcla una regla transversal de calidad con un método de desarrollo que no se
  activa en todas las tareas y vuelve ambiguo su alcance fuera de TDD.
- **Archivo independiente cargado sólo desde cada rol.** Conserva una única
  definición y deja la instrucción cerca de cada consumidor, pero dispersa el
  inventario de consumo y facilita que un rol nuevo o modificado quede fuera sin
  una señal central.
- **Archivo independiente con carga combinada** (elegida). Une un registro
  central auditable con enlaces operativos locales. A cambio, la lista de
  consumidores debe mantenerse coherente en la política de orquestación, los
  cuatro roles y la prueba estructural.

## Consecuencias

La Regla de Oro tiene una sola definición, sin copias en roles, workflows,
adapters, `AGENTS.md` ni documentación. Planificador, Implementador, Tester y
Evaluador son sus únicos consumidores explícitos; incorporar al Explorador o al
Documentador exige evidencia y una decisión posterior.

La distribución pasa a ser parte de la garantía: cualquier alta, baja o cambio
de ruta debe conservar alineados el inventario del inicializador, el
inventario del paquete, las referencias de consumo y las pruebas de estructura
y adopción. El coste aceptado es esa actualización coordinada; el beneficio es
que una política crítica no puede existir sin que su instalación y consumo sean
observables.
