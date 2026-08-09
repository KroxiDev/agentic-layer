---
name: agentic-diagnostico-bugs
description: Diagnostica bugs difíciles y regresiones de rendimiento mediante un bucle rojo-capaz, reproducción mínima, hipótesis falsables, instrumentación dirigida y test de regresión. Usar internamente en el workflow bugfix cuando se reporte comportamiento roto, erróneo, intermitente o lento.
---

# Diagnóstico agéntico de bugs

Seguir las fases en orden y justificar explícitamente cualquier omisión. Leer el
contrato efectivo, la DevSession y el workflow `bugfix`.

## Protección de secretos

Redactar credenciales y datos sensibles como `<REDACTED>` antes de mostrar
comandos, salidas o artefactos. Usar mecanismos seguros ya configurados por el
proyecto y no pedir que el usuario pegue secretos. Citar únicamente la señal
necesaria de una captura.

## Fase 1 — Construir un bucle rojo-capaz

Esta fase es el núcleo de la disciplina; las demás son mecánicas. Con una señal
pasa/falla ajustada al bug, la bisección, la prueba de hipótesis y la
instrumentación solo la consumen. Sin ella, ninguna cantidad de lectura de
código sustituye la evidencia. Dedicar aquí un esfuerzo desproporcionado y
agotar las alternativas antes de declarar el bloqueo.

Crear una señal pasa/falla que alcance el patrón real del bug y detecte el
síntoma exacto informado. Intentar, según el sistema:

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
tasa y registrarla antes de pasar a la fase siguiente.

Nombrar un comando o procedimiento que ya se haya ejecutado y registrar su
salida redactada. Si no se puede construir el bucle, detenerse, listar lo
intentado y pedir mediante el orquestador acceso al entorno, un artefacto
redactado o autorización para instrumentación temporal. No formular teorías
antes de tener una señal rojo-capaz.

## Fase 2 — Reproducir y minimizar

Ejecutar el bucle y confirmar que reproduce el síntoma del usuario, no un fallo
cercano. Repetirlo para comprobar estabilidad.

Reducir entradas, configuración, callers y pasos de uno en uno, ejecutando el
bucle después de cada reducción. Terminar cuando cada elemento restante sea
necesario para mantener el rojo.

## Fase 3 — Formular hipótesis

Generar entre tres y cinco hipótesis rankeadas antes de probar una. Expresar
cada una como predicción falsable:

~~~text
Si <causa> explica el bug, entonces <cambio controlado> producirá
<resultado observable>.
~~~

Descartar o afilar hipótesis sin predicción. Usar CodeGraph para rutas e impacto
y Engram para antecedentes concretos. Devolver la lista al orquestador para que
la presente al usuario antes de instrumentar.

Es un checkpoint informativo y **no bloqueante**: el usuario suele rerankear al
instante con conocimiento que el agente no tiene, pero si no responde, continuar
con el ranking propio y registrarlo en la DevSession. Sí bloquea, en cambio,
toda instrumentación que requiera autorización previa por sí misma: entornos
compartidos o productivos, cambios persistentes y cualquier acción restringida
por el contrato efectivo.

## Fase 4 — Instrumentar

Vincular cada sonda con una predicción y cambiar una variable por vez. Preferir
inspección directa; después, logs dirigidos en los puntos que distinguen
hipótesis. No registrar todo para buscar señal después.

Etiquetar instrumentación temporal con un identificador único como
`[DEBUG-<id>]`. Para rendimiento, establecer primero una medición base y usar
perfilado o bisección apropiados; medir antes de corregir.

## Fase 5 — Corregir y proteger la regresión

Comprobar que existe un seam capaz de reproducir el patrón real del bug. Si no
existe, registrar esa limitación arquitectónica en vez de crear un test
superficial que dé confianza falsa.

Con seam correcto:

1. convertir la reproducción mínima en test;
2. verlo fallar por el síntoma exacto;
3. aplicar el cambio mínimo;
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
