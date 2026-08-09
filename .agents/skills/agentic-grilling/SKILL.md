---
name: agentic-grilling
description: Estructura decisiones ambiguas como un árbol y devuelve rondas completas de preguntas accionables. Usar internamente durante la planificación cuando una especificación, plan o decisión requiera elecciones del usuario que no puedan resolverse como hechos con herramientas.
---

# Grilling agéntico

## Árbol de decisiones

1. Modelar cada decisión abierta como un nodo.
2. Registrar como dependencias las decisiones cuya respuesta condiciona otra.
3. Calcular la frontera: todos los nodos no resueltos cuyos prerrequisitos ya
   estén resueltos.
4. Investigar con herramientas cualquier hecho necesario para formular la
   frontera. Preguntar al usuario solo decisiones.
5. Devolver en una misma ronda todas las preguntas de la frontera.
6. Esperar las respuestas antes de recalcular la frontera siguiente.
7. Terminar cuando no queden nodos abiertos y exista entendimiento compartido.

No adelantar preguntas que dependan de una respuesta todavía abierta. Una
exploración en curso bloquea solo sus decisiones dependientes, no el resto de
la frontera.

## Formato de ronda

Numerar todas las preguntas y aportar una recomendación explícita:

~~~text
❓ P1 — <título>: <decisión solicitada, contexto y opciones relevantes>

➡️ Recomendación: <opción y razón breve>
~~~

En un workflow orquestado, devolver la ronda al orquestador. No hablar
directamente con el usuario ni reformular sus respuestas.
