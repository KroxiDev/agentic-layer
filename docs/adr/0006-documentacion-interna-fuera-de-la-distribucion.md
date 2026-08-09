# La documentación interna queda fuera de la distribución

`CONTEXT.md` y `docs/` documentan el mantenimiento de esta plantilla y no viajan
en el paquete: un proyecto que adopta la capa recibe el proceso, no el glosario
ni las decisiones de quien lo construyó. Elegimos esto en lugar de distribuirlos
porque el inventario canónico es una promesa —lo que aparece en el destino es lo
que la capa necesita— y un `docs/` ajeno aterrizando en la raíz de un proyecto
adoptante la rompe.

## Consecuencias

La integridad estructural resuelve todos los enlaces Markdown del inventario
canónico, y `README.md` sí se distribuye. Como el README enlaza a la
documentación interna, el validador omite los enlaces a rutas exclusivas del
desarrollo cuando corre desde un paquete instalado, donde esas rutas no existen,
y los comprueba con normalidad en el checkout de desarrollo, que es donde puede
haber drift.

Eso significa que los enlaces del README a `CONTEXT.md` y `docs/` quedan
colgados dentro del paquete instalado, y resueltos donde se leen de verdad: en
GitHub y en la página de npm, que los resuelven contra el repositorio.
