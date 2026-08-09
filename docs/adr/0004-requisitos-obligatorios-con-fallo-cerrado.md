# CodeGraph y Engram son obligatorios, con fallo cerrado

La orquestación exige CodeGraph, Engram, subagentes aislados y contrato completo,
y se detiene si falta cualquiera en lugar de degradar a grep, memoria improvisada
o ejecución secuencial de roles en un solo hilo. Elegimos el fallo cerrado porque
la degradación silenciosa produce el peor resultado posible: un proceso que
parece haber corrido con sus garantías y no las tuvo, sin que nadie pueda
distinguirlo del que sí.

## Consecuencias

El inicializador comprueba ambas herramientas y termina con código `4` cuando
alguna falta, **después** de haber copiado los archivos: la capa queda instalada
pero no puede orquestar, y la salida indica qué instalar. Esa asimetría es
deliberada — la copia es útil y reversible; orquestar sin las herramientas, no.

Las comprobaciones son de sólo lectura: CodeGraph se consulta con `status` y sólo
se inicializa o sincroniza mediante una bandera de confirmación explícita. De
Engram se comprueba únicamente que el ejecutable responda; la identidad del
proyecto se confirma desde el host de agentes, porque es ahí donde el MCP la
resuelve.

Coste aceptado: la capa no es adoptable «en seco». Un repositorio sin esas dos
herramientas obtiene los archivos y una lista de tareas pendientes, no un
proceso funcionando.
