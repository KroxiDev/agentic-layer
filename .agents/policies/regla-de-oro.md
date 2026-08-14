# Regla de Oro

Simple y concreto antes que genérico y abstracto. La solución correcta es
el código más pequeño y legible que resuelve el requisito real —ni una
línea más por lo que "podría necesitarse después".

## Alcance y precedencia

- La regla gobierna *cómo* se resuelve, nunca *si* se cumple el requisito.
  Validación, manejo de errores, seguridad y las convenciones ya
  establecidas en el repositorio no cuentan como "líneas de más".
- Ante conflicto: especificación > convenciones del proyecto > Regla de Oro.
- Un **refactor local habilitante** no necesita una petición separada cuando no
  agrega comportamiento, permanece en el sector, seam y rutas aprobados, no
  altera interfaces no autorizadas y resulta necesario para conservar claridad,
  evitar duplicación real o completar el ciclo verde.
- Todo **refactor oportunista** sin relación con el requisito o fuera del sector
  aprobado continúa prohibido. Una limpieza más amplia vuelve al Planificador o
  se convierte en una tarea separada.
- Si la regla choca con la claridad, gana la claridad. Menos código no
  significa código más denso ni ingenioso.

## Al escribir código

- Resolver el caso que existe hoy, no la familia de casos imaginables.
- No abstraer por anticipación. Una **abstracción justificada** oculta una
  invariante compartida estable, reduce la interface o el conocimiento repetido
  y mejora el leverage o la localidad.
- Tres repeticiones activan una revisión, no una extracción automática. Si los
  bloques solo muestran similitud accidental, conservar una duplicación pequeña
  puede ser más claro que crear una abstracción superficial.
- Un solo caller o adapter, sin un problema concreto, no justifica una
  indirección. Dos adapters demuestran un seam real; aun así, extraer exige la
  invariante estable y la mejora concreta anteriores.
- Antes de agregar una capa, indirección o parámetro de configuración,
  justificar qué problema concreto elimina. Sin respuesta, no va.
- Reutilizar lo que ya existe en el proyecto antes de crear algo paralelo.

## Al escribir pruebas

- Una prueba entra a la suite solo si puede fallar por una razón real.
  Si no se puede describir el bug que atraparía, no se escribe.
- Piso mínimo: cada camino de error y cada borde declarado en el requisito
  necesita al menos una prueba. "Pocas y de alto alcance" no significa
  ninguna.
- Probar comportamiento observable, no detalles de implementación: si un
  refactor sin cambio funcional la rompe, está mal escrita.
- Nada de pruebas que se validan a sí mismas (mocks que devuelven lo que
  la prueba después afirma) ni asserts triviales sobre constantes.
- Alcance según el objetivo: pruebas de flujo para la integración entre
  piezas, unitarias para lógica con ramas o cálculo.
- Prohibido dejar pruebas omitidas o marcadas como skip.

## Ante una prueba en rojo

Primero diagnosticar contra el requisito, no contra el código. El
comportamiento actual del código nunca es evidencia de que la prueba esté
mal; la única evidencia válida es el requisito vigente. Según el caso:

- **La prueba representa correctamente un requisito vigente** → se corrige
  el código. Es el caso por defecto.
- **La prueba está mal escrita** (contradice el requisito, o verifica algo
  que el requisito no pide) → se corrige la prueba, citando el requisito
  que la contradice.
- **El comportamiento dejó de ser requisito** → se elimina la prueba.

Modificar o eliminar una prueba altera la cobertura: en ambos casos hay que
declararlo explícitamente en el reporte de cambios y, si se crea un commit,
también en su mensaje.
