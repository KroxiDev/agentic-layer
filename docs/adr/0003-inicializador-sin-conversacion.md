# El inicializador no conversa: marca campos pendientes

`agentic init` no pregunta ningún hecho del contrato. Escribe lo que puede
inferir y deja `<pendiente: …>` en el resto, listándolo al terminar en el bloque
`CONTRATO POR COMPLETAR`. Decidimos esto porque los hechos que faltan —el
propósito real, la estrategia Git permitida— requieren contexto y conversación,
y un prompt de terminal a una línea es el peor lugar posible para decidirlos: se
responde con lo primero que suene bien y el contrato queda con un valor
plausible pero falso, que es peor que un hueco declarado.

## Consecuencias

La adopción se completa siempre con un solo comando y nunca falla por un dato
ausente, con o sin terminal, con o sin `--yes`. Quien bloquea el trabajo después
es la regla `STRICT_PROJECT_CONTRACT_RULE`, en la primera tarea orquestada, donde
la skill `agentic-grilling` sí tiene contexto para resolver los campos.

Un contrato incompleto **no** altera el código de salida: la adopción fue
correcta. `--purpose` y `--git-strategy` existen como atajo para quien ya tiene
la respuesta a mano, nunca como requisito.

Consecuencia menos obvia: una copia de la plantilla trae su propio `README.md`,
así que el inicializador descarta el propósito detectado cuando coincide con el
de la plantilla y el contrato del destino sigue siendo el suyo sin tocar. Sin esa
regla, todo proyecto creado con «Use this template» heredaría «mantener una
plantilla declarativa y reusable» como su propio propósito.
