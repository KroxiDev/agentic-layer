# Política SDD y TDD

SDD define qué se debe construir, por qué, con qué límites y cómo se comprobará.
TDD implementa comportamientos puntuales mediante rebanadas verticales
rojo → verde. La especificación decide cuándo aplicar TDD y el contrato efectivo
de `AGENTS.md` decide herramientas, comandos, ubicación y permanencia de tests.

## SDD proporcional

Aplicar SDD cuando el cambio afecte varios archivos o módulos, introduzca
comportamiento, tenga criterios ambiguos, cambie una interface o pueda afectar
compatibilidad y arquitectura. Ajustar la extensión de la especificación al
riesgo; una tarea pequeña puede resolverse con objetivo, criterios y límites en
pocas líneas.

La especificación debe incluir:

1. objetivo y comportamiento esperado;
2. criterios de aceptación verificables;
3. no-objetivos y restricciones;
4. puntos de integración y seams públicos afectados;
5. tareas pequeñas y ordenadas;
6. estrategia de validación y ciclo de vida de cada test nuevo.

## Cuándo aplicar TDD

Usar TDD en `full` cuando exista comportamiento puntual y observable: una
regresión reproducible, lógica con casos límite, una invariante o una interface
que merezca protección. Aplicar `.agents/skills/agentic-tdd/SKILL.md`.

No forzar TDD para cambios puramente textuales, metadatos o trabajo sin un seam
observable útil. En `light`, no crear tests por defecto; hacerlo solo si la
especificación o el riesgo lo exige.

## Ciclo de vida de tests

- La especificación debe marcar cada test nuevo como temporal o permanente
  según el contrato efectivo.
- Nunca eliminar tests preexistentes.
- Solo eliminar al cierre tests creados durante la DevSession, registrados como
  temporales y permitidos por la política del proyecto.
- No fijar aquí framework, ruta ni comando. Esos hechos pertenecen a
  `AGENTS.md`.

## Criterio de finalización

Los tests en verde no bastan. El Evaluador comprueba el comportamiento contra
la especificación, el alcance aprobado, las reglas efectivas y la evidencia de
integración pertinente.
