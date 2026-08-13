# Política SDD y TDD

SDD define qué se debe construir, por qué, con qué límites y cómo se comprobará.
TDD implementa comportamientos puntuales mediante rebanadas verticales
rojo → verde, con un refactor acotado opcional después de alcanzar verde. La
especificación decide cuándo aplicar TDD y el contrato efectivo
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

## Vocabulario de diseño

Usar estos términos al definir seams, discutir la forma de una interface o
justificar dónde vive un test. Son vocabulario compartido entre Planificador,
Implementador, Tester y Evaluador, no una metodología a ejecutar.

- **Módulo:** unidad con una interface pública y una implementación oculta.
- **Interface:** lo que un caller necesita conocer para usar el módulo.
- **Profundidad:** relación entre funcionalidad provista e interface expuesta.
  Un módulo profundo resuelve mucho detrás de una interface pequeña.
- **Seam:** límite público donde se observa comportamiento sin acceder al
  interior. Los tests viven en seams.
- **Adapter:** módulo delgado que traduce entre un límite externo y el
  vocabulario del proyecto.
- **Leverage:** cuánto comportamiento queda cubierto por un solo seam.
- **Localidad:** cuánto contexto disperso hace falta para entender un cambio.

Una interface cuya forma sigue en discusión es una decisión de especificación,
no de implementación. Resolverla antes de escribir tests contra ella.

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
