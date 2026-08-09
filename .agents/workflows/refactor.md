# Workflow: refactor

Usar para reestructurar una implementación sin cambiar su comportamiento
observable.

1. **Explorar — Explorador:** delimitar sector, dependientes, seams y reglas
   efectivas.
2. **Definir invariantes — Planificador:** enumerar lo que no debe cambiar y la
   evidencia que lo protege.
3. **Implementar — Implementador:** cambiar en pasos pequeños dentro del sector
   aprobado.
4. **Testear — Tester:** comprobar invariantes con la validación declarada.
5. **Evaluar — Evaluador:** verificar ausencia de regresiones y una mejora real
   de profundidad, leverage o localidad, sin abstracción gratuita.
6. **Documentar — Documentador:** actuar solo si la reestructura cambia
   interfaces o documentación vigente.

En `light` no introducir seams ni abstracciones nuevas salvo que sean el objeto
explícito aprobado.
