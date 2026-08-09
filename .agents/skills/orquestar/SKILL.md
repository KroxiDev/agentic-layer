---
name: orquestar
description: Orquesta tareas de desarrollo mediante roles aislados, DevSession y workflows full o light. Usar cuando el usuario pida orquestar una tarea o cuando una tarea no trivial de feature, bugfix, refactor o arquitectura deba activar automáticamente la capa agéntica.
---

# Orquestar

1. Leer `AGENTS.md` y `.agents/policies/orquestacion.md`.
2. Ejecutar el preflight obligatorio y detenerse si falla un requisito.
3. Seleccionar workflow y modo; usar `full` por defecto y `light` solo por
   petición explícita.
4. Crear una DevSession desde `.agents/templates/dev-session.md`.
5. Leer el workflow elegido en `.agents/workflows/`.
6. Delegar cada fase al rol correspondiente en un contexto aislado, pasando
   únicamente la DevSession, las reglas efectivas y los artefactos necesarios.
7. Registrar solo el reporte contractual de cada rol y relevar al usuario las
   preguntas o aprobaciones.
8. Aplicar el límite de dos ciclos Evaluador → Implementador.
9. Cerrar según la política: limpiar únicamente tests temporales autorizados,
   repetir la validación pertinente, documentar, consolidar Engram y eliminar
   la DevSession.

No ejecutar roles secuencialmente en el hilo del orquestador ni sustituir
subagentes con procesos de CLI.
