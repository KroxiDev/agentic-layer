# Cero dependencias: sólo la biblioteca estándar de Node

El inicializador, el ejecutable y los tests usan exclusivamente la biblioteca
estándar de Node.js 20 y `node:test`. El manifiesto no declara `dependencies`,
`devDependencies` ni ninguna otra variante, y la integridad estructural falla si
aparecen. Lo decidimos porque el comando de adopción se ejecuta con `npx` en
repositorios ajenos: cada dependencia sería descarga, superficie de suministro y
latencia en el único momento en que el usuario está esperando.

## Consecuencias

Hay un parser de argumentos, un lector parcial de TOML y un caminador de
directorios escritos a mano. Es código que una librería resolvería mejor, y está
ahí a propósito: quien lo encuentre no debe «arreglarlo» añadiendo una
dependencia. El lector de TOML cubre sólo lo que la detección necesita —
secciones planas y cadenas— y no pretende ser completo.

`node:test` como framework implica que la suite es la especificación ejecutable
de la CLI y corre sin instalar nada, en directorios temporales autolimpiables y
sin tocar nunca el registro de npm.
