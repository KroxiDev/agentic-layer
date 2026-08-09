# Template de bucle HITL

Usar únicamente cuando la reproducción requiera una acción humana que el agente
no pueda automatizar. No crear un script por anticipado.

## Preparación

1. Definir el síntoma exacto y la condición pasa/falla.
2. Indicar qué consola y entorno corresponden al caso real.
3. Separar acciones humanas de observaciones capturadas.
4. Mantener autenticación, credenciales y secretos como acciones `step`; nunca
   solicitarlos mediante `capture`.
5. Generar un script temporal en el lenguaje de consola adecuado solo cuando
   sea necesario y registrarlo en la DevSession. Partir de
   `hitl-loop.template.sh` en consolas POSIX o de `hitl-loop.template.ps1` en
   PowerShell; escribir uno desde cero solo si ninguno encaja con el entorno.

## Semántica

- `step "<instrucción>"`: mostrar una acción, esperar confirmación y no capturar
  su contenido.
- `capture <CLAVE> "<pregunta>"`: capturar únicamente una observación redactada
  que ayude a decidir pasa/falla.

El script generado debe:

1. fallar ante errores propios del script;
2. presentar pasos numerados y sin ambigüedad;
3. no imprimir variables de entorno, tokens ni datos sensibles;
4. indicar cómo abortar sin perder el contexto;
5. terminar con un bloque estructurado que el usuario devuelva al agente.

## Esqueleto abstracto

~~~text
step "Realizar la acción humana en el entorno indicado."
capture SINTOMA "¿Apareció el síntoma exacto? Responder sí/no."
capture DETALLE "Describir solo la observación relevante, sin secretos."
~~~

## Salida obligatoria

~~~text
--- Capturado ---
SINTOMA=<valor>
DETALLE=<valor redactado>
~~~

Explicar al usuario cómo ejecutar el script, qué bloque compartir y qué
información no debe incluir. Después de usarlo, retirar el script temporal o
conservarlo únicamente si la especificación lo exige.
