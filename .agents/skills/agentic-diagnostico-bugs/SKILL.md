---
name: agentic-diagnostico-bugs
description: Diagnostica bugs difíciles y regresiones de rendimiento mediante un bucle rojo-capaz, reproducción mínima, hipótesis falsables, instrumentación dirigida y test de regresión. Usar internamente en el workflow bugfix cuando se reporte comportamiento roto, erróneo, intermitente o lento.
---

# Diagnóstico agéntico de bugs

Ajustar la profundidad del diagnóstico a la incertidumbre y al riesgo. Conservar
siempre el orden reproducir → explicar → corregir → proteger, pero omitir
mecánica que no aumente la información con una justificación breve. Leer el
contrato efectivo, la DevSession y el workflow `bugfix`.

Una señal rojo-capaz o evidencia equivalente debe demostrar el fallo antes de
corregir. La explicación debe separar la causa del síntoma y la corrección debe
ser la mínima compatible con la evidencia.

## Protección de secretos

Redactar credenciales y datos sensibles como `<REDACTED>` antes de mostrar
comandos, salidas o artefactos. Usar mecanismos seguros ya configurados por el
proyecto y no pedir que el usuario pegue secretos. Citar únicamente la señal
necesaria de una captura.

## Fase 1 — Construir un bucle rojo-capaz

Esta fase es el núcleo de la disciplina; las demás son mecánicas. Con una señal
pasa/falla ajustada al bug, la bisección, la prueba de hipótesis y la
instrumentación solo la consumen. Sin ella, ninguna cantidad de lectura de
código sustituye la evidencia. Definir antes de empezar qué resultado bastará y
qué límite de tiempo, acceso o intentos obligará a detenerse.

Crear una señal pasa/falla que alcance el patrón real del bug y detecte el
síntoma exacto informado. Elegir la alternativa más pequeña adecuada al sistema
y pasar a otra solo cuando la anterior no produzca evidencia suficiente:

1. test automatizado en un seam público;
2. invocación del entrypoint con una entrada controlada y salida conocida;
3. automatización de la interface visible;
4. replay de una captura redactada;
5. harness descartable del subconjunto mínimo;
6. bucle de propiedades o estrés para fallos intermitentes;
7. comparación diferencial o bisección entre estados conocidos;
8. HITL como último recurso, siguiendo el contrato de
   `references/hitl-loop.template.md` y partiendo del esqueleto ejecutable que
   corresponda a la consola: `references/hitl-loop.template.sh` o
   `references/hitl-loop.template.ps1`.

Ajustar el bucle hasta que sea:

- **rojo-capaz:** puede fallar por el síntoma exacto;
- **determinista:** produce un veredicto estable o una tasa de reproducción
  suficientemente alta y medida;
- **rápido:** permite iteración frecuente según los límites del proyecto;
- **ejecutable por el agente:** salvo el último recurso HITL.

Tratar el bucle como un producto y ajustarlo en cuanto exista una primera
versión:

- **más rápido:** cachear el setup, omitir inicialización no relacionada,
  estrechar el alcance del caso;
- **señal más afilada:** asertar el síntoma específico, nunca "no falló";
- **más determinista:** fijar el tiempo, sembrar la aleatoriedad, aislar el
  filesystem y congelar el acceso a red.

Un bucle inestable y lento apenas mejora la ausencia de bucle; uno determinista
y rápido es la herramienta que resuelve el caso.

### Bugs no deterministas

El objetivo no es una reproducción limpia sino una **tasa de reproducción más
alta y medida**. Ejecutar el disparador en bucle muchas veces, paralelizar,
añadir carga o estrés, estrechar ventanas de temporización e inyectar esperas
en los puntos sospechosos. Un fallo que aparece la mitad de las veces es
diagnosticable; uno que aparece una de cada cien no lo es. Seguir subiendo la
tasa dentro de los criterios de parada y registrarla antes de pasar a la fase
siguiente; si no alcanza una señal útil, aplicar la ruta de bloqueo.

Nombrar un comando o procedimiento que ya se haya ejecutado y registrar su
salida redactada. No formular teorías antes de tener una señal rojo-capaz o
evidencia equivalente. Si no puede construirse dentro de los criterios de
parada, aplicar la ruta de bloqueo.

## Clasificación del diagnóstico

Clasificar con la evidencia disponible antes de formular hipótesis. Revaluar la
ruta si una prueba revela otra explicación compatible.

### Ruta directa

Usar cuando la señal es determinista, la causa queda aislada por el compilador,
un test, un stack trace, una comparación o inspección dirigida, y no existe otra
explicación compatible ni hace falta instrumentación riesgosa o acceso
adicional.

Avanzar con una hipótesis explícita, su predicción falsable y la evidencia que
la respalda. Esta ruta no requiere un checkpoint informativo: continuar sin
preguntar al usuario mientras no falte una decisión, información o
autorización.

### Ruta investigativa

Usar cuando causas plausibles compiten, la señal reproduce solo parte del
síntoma, el fallo depende del entorno o hace falta instrumentación para
discriminar. Formular varias hipótesis únicamente cuando existan explicaciones
reales respaldadas y expresar cada una como predicción falsable; no imponer un
mínimo fijo.

Abrir un checkpoint únicamente cuando existan causas competidoras sobre las que
el conocimiento útil del usuario pueda cambiar el orden, falte información que
el usuario pueda aportar o la instrumentación requiera autorización. Sin una de
esas condiciones, continuar con la evidencia disponible.

Los bugs intermitentes y de rendimiento siempre permanecen en esta ruta:
registrar la tasa de reproducción o una medición base y medir de nuevo después
del arreglo.

### Bloqueo

Detenerse cuando no pueda construirse una señal válida tras los intentos
razonables definidos, falte acceso, artefacto o autorización indispensable, o
seguir consumiendo recursos no aumente la información en proporción al riesgo.

Informar la señal intentada, los límites alcanzados y el dato indispensable
para continuar. Registrar los intentos relevantes y su resultado; no recorrer
opciones que ya no puedan discriminar una causa.

## Fase 2 — Reproducir y minimizar

Ejecutar el bucle y confirmar que reproduce el síntoma del usuario, no un fallo
cercano. Repetirlo para comprobar estabilidad.

Reducir entradas, configuración, callers y pasos de uno en uno, ejecutando el
bucle después de cada reducción. Terminar cuando cada elemento restante sea
necesario para mantener el rojo o la causa ya esté aislada. En la ruta directa,
omitir reducciones adicionales que no cambien la explicación y registrar el
motivo brevemente.

## Fase 3 — Explicar la causa

Aplicar la clasificación elegida: una hipótesis respaldada en la ruta directa o
varias hipótesis cuando compitan explicaciones reales. Expresar cada hipótesis
como predicción falsable:

~~~text
Si <causa> explica el bug, entonces <cambio controlado> producirá
<resultado observable>.
~~~

Descartar o afilar hipótesis sin predicción. Usar CodeGraph para rutas e impacto
y Engram para antecedentes concretos. Explicar por qué la causa propuesta
produce el síntoma observado y qué evidencia descarta las alternativas que
realmente compitieron. Aplicar únicamente el checkpoint definido por la ruta
investigativa.

## Fase 4 — Instrumentar

Vincular cada sonda con una predicción y cambiar una variable por vez. Preferir
inspección directa; después, logs dirigidos en los puntos que distinguen
hipótesis. No registrar todo para buscar señal después.

Etiquetar instrumentación temporal con un identificador único como
`[DEBUG-<id>]`. Para rendimiento, establecer primero una medición base y usar
perfilado o bisección apropiados; medir antes de corregir.

La instrumentación sensible o persistente, los entornos compartidos o
productivos y cualquier acción restringida quedan bloqueados hasta obtener la
autorización exigida por el contrato efectivo.

## Fase 5 — Corregir y proteger la regresión

Comprobar que existe un seam público capaz de reproducir el patrón real del bug
y que el riesgo justifica una regresión durable. Si el seam no existe, registrar
esa limitación arquitectónica en vez de crear un test superficial que dé
confianza falsa. Si el riesgo no justifica un test nuevo, conservar la señal
rojo-capaz y registrar el motivo.

Con seam correcto y regresión pertinente:

1. convertir la reproducción mínima en test;
2. verlo fallar por el síntoma exacto;
3. aplicar la corrección mínima que elimina la causa;
4. verlo pasar;
5. ejecutar de nuevo el bucle original sin minimizar.

Aplicar `agentic-tdd` y la política de permanencia definida por la
especificación y `AGENTS.md`.

## Fase 6 — Limpiar y cerrar

Antes del veredicto:

- confirmar que la reproducción original ya no falla;
- confirmar el test de regresión o documentar la ausencia de seam;
- retirar toda instrumentación `[DEBUG-...]`;
- eliminar harnesses descartables autorizados;
- registrar la causa confirmada y la evidencia;
- proponer después del fix cualquier mejora arquitectónica que habría prevenido
  el bug, derivándola al workflow `architecture` con la evidencia concreta —
  ausencia de seam, callers enredados, acoplamiento oculto — y nunca antes de
  que la corrección esté aplicada.

Guardar en Engram solo la causa y solución validadas que sean reutilizables; no
guardar hipótesis descartadas ni logs transitorios.
