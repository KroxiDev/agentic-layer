---
name: agentic-tdd
description: Ejecuta desarrollo guiado por tests en rebanadas verticales rojo a verde y diseña tests durables en seams públicos. Usar internamente cuando la especificación marque una tarea TDD, al crear una regresión o al verificar comportamiento observable que justifique tests nuevos.
---

# TDD agéntico

Aplicar esta skill durante cada ciclo, no como revisión posterior. Leer primero
el contrato efectivo de `AGENTS.md`, la especificación y
`.agents/policies/sdd-tdd.md`.

## Confirmar el seam

Registrar antes de escribir un test:

- la interface pública observada;
- el comportamiento y resultado observable;
- el seam acordado en la especificación;
- si el test será temporal o permanente.

Si el seam no está acordado o la forma de la interface sigue abierta, detener
el ciclo y devolver la decisión al orquestador. No crear un test contra una
interface imaginada.

Formular esa devolución con el vocabulario de diseño de
`.agents/policies/sdd-tdd.md`: qué módulo se está tocando, qué interface expone,
qué profundidad tiene y dónde debería quedar el seam. Es vocabulario para
plantear la decisión, no una sesión de diseño a ejecutar dentro del ciclo.

## Diseñar un test valioso

- Verificar comportamiento que importe a callers o usuarios.
- Usar únicamente la interface pública.
- Nombrar el test como una capacidad o regla, no como un detalle interno.
- Obtener el valor esperado de una fuente independiente: especificación,
  ejemplo trabajado o literal conocido.
- Mantener una aserción lógica por test.
- Exigir que el test sobreviva una reestructura interna sin cambio de
  comportamiento.

Tomar los nombres de tests e interfaces del lenguaje de dominio ya establecido
en el proyecto: el contrato efectivo de `AGENTS.md`, la especificación vigente y
el historial de Engram. Consultar además los ADR del sector cuando el contrato
declare una ubicación. No introducir términos nuevos para conceptos que el
proyecto ya nombra.

Ejemplo neutral:

~~~text
escenario "una solicitud válida queda disponible":
    resultado = modulo.procesar(solicitud_valida)
    observado = modulo.consultar(resultado.identificador)
    afirmar observado.estado == "disponible"
~~~

## Mocking

Usar mocks solo en límites externos reales:

- sistemas fuera del control del proyecto;
- tiempo o aleatoriedad;
- recursos remotos;
- filesystem cuando no exista un sustituto local adecuado.

Preferir sustitutos reales locales cuando sean rápidos y deterministas.
Inyectar dependencias externas mediante interfaces específicas por operación.
No mockear módulos propios, colaboradores internos ni métodos privados.

## Evitar anti-patrones

- **Acoplamiento a implementación:** asertar llamadas internas, orden privado o
  conteos de invocaciones sin significado observable.
- **Verificación lateral:** inspeccionar estado interno por una ruta distinta de
  la interface pública.
- **Test tautológico:** recalcular el esperado con el mismo algoritmo del
  módulo.
- **Slicing horizontal:** escribir todos los tests imaginados antes de aprender
  de la primera implementación.

Los dos que peor se reconocen sin verlos:

~~~text
# MAL — verificación lateral: confirma por un almacén interno
escenario "registrar deja el usuario disponible":
    modulo.registrar(datos)
    fila = almacen_interno.consultar("usuarios", datos.nombre)
    afirmar fila existe

# BIEN — verifica por la misma interface pública
escenario "registrar deja el usuario disponible":
    creado = modulo.registrar(datos)
    afirmar modulo.consultar(creado.identificador).nombre == datos.nombre
~~~

~~~text
# MAL — tautológico: el esperado repite el algoritmo del módulo
escenario "el total suma las líneas":
    lineas = [10, 5]
    esperado = reducir(lineas, sumar, 0)
    afirmar modulo.total(lineas) == esperado

# BIEN — el esperado es un literal independiente
escenario "el total suma las líneas":
    afirmar modulo.total([10, 5]) == 15
~~~

## Ciclo rojo → verde

1. Escribir un test para una sola rebanada vertical.
2. Ejecutarlo y comprobar que falla por la ausencia exacta del comportamiento,
   no por setup o infraestructura.
3. Implementar únicamente lo necesario para ponerlo en verde.
4. Ejecutar de nuevo y registrar la evidencia.
5. Repetir con la siguiente rebanada a partir de lo aprendido.

La reestructuración no forma parte del ciclo rojo → verde: pertenece a la fase
de evaluación del workflow, donde el Evaluador la solicita como cambio
requerido. No anticipar funcionalidad ni abstracciones durante el ciclo.

## Cierre

- Ejecutar la validación exigida por el contrato efectivo.
- Registrar tests temporales y permanentes por separado en la DevSession.
- No eliminar tests preexistentes.
- Eliminar al cierre solo tests creados en la DevSession, marcados como
  temporales y cuya eliminación esté permitida.
