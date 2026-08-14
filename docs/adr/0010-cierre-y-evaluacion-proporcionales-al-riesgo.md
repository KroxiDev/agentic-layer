# Cierre y evaluación proporcionales al riesgo

**Estado: Aceptada**

## Contexto

La ADR 0009 introdujo unidades atribuibles, fan-in por generaciones y dos ejes
independientes de evaluación para todo workflow `full`. Esa separación preserva
seguridad y trazabilidad, pero convirtió el modo en un sustituto del riesgo: una
unidad acotada repetía la suite completa y siempre abría dos Evaluadores. A la
vez, `architecture` delegaba la implementación a `feature` o `refactor` y luego
volvía a evaluar y documentar un resultado que el workflow posterior ya había
cerrado.

La auditoría también detectó que la validación llamada focalizada en el contrato
de este repositorio ejecutaba literalmente los 99 tests, y que la regla TDD de
una aserción lógica por test fragmentaba comportamientos y desplazaba un
refactor interno seguro hasta un rechazo del Evaluador.

## Decisión

### Validación por unidad y fan-in

Cada unidad se valida mediante un caso, patrón o procedimiento focalizado y
concreto. El Implementador conserva evidencia proporcional y el Tester aporta
evidencia atribuible, pero ninguno repite la suite completa por unidad.

En `full`, la validación completa se ejecuta una sola vez después de consolidar
las unidades y ejecutar el fan-in, y antes de abrir la evaluación final. Si se
eliminan tests temporales al cierre, se repite únicamente la validación afectada;
la suite completa sólo se repite ante evidencia concreta de impacto transversal.
`light` conserva su política vigente de no ejecutar la suite completa por
defecto.

### Estrategia de evaluación

Toda DevSession nueva por unidades registra `evaluationStrategy`. El valor
predeterminado es `combined`: un Evaluador `read-only` cubre conjuntamente
Estándares y Especificación, también en `full`.

`dual` requiere que el plan registre antes del fan-in exactamente una categoría
`evaluationRisk` admitida:

- `architectural-decision`;
- `security-or-integrity`;
- `public-compatibility-or-migration`;
- `considerable-fan-in`.

La estrategia dual mantiene dos Evaluadores independientes, uno por eje. Ambas
estrategias conservan intentos monotónicos, permiso `read-only`, generación
vigente, invalidación completa tras retrabajo y aprobación de todos los ejes
requeridos. El controlador rechaza estrategias, riesgos y ejes incompatibles.

Una DevSession `full` creada antes de estos campos conserva los ejes duales
implícitos. Un `init` explícito puede completar el plan con
`evaluationStrategy: dual` y `evaluationRisk: legacy-full-mode`; ese valor es
sólo de compatibilidad y no puede solicitarse para una sesión nueva.

### Cierre de `architecture`

`architecture` explora, compara, redacta la propuesta, obtiene aprobación
explícita y registra la decisión aceptada. Una tarea exclusivamente de decisión
termina allí, sin unidades, implementación, testing ni evaluación de código.

Si la decisión debe materializarse, `architecture` se cierra y la transfiere una
sola vez a `feature` o `refactor` como restricción y criterio de aceptación. El
workflow posterior es el único responsable de implementar, testear, evaluar y
documentar el resultado final. No existe un segundo cierre equivalente en
`architecture`.

### Ciclo TDD

Cada test demuestra un comportamiento observable y puede usar todas las
aserciones necesarias para probarlo. Después de alcanzar verde se permite un
refactor acotado que no introduzca comportamiento, amplíe alcance ni altere
interfaces no aprobadas. La validación focalizada se repite después del
refactor. El Evaluador sigue comprobando simplicidad y ausencia de abstracciones
gratuitas.

## Relación con decisiones anteriores

Esta ADR sustituye únicamente la fuerza 8 y la regla de D5 de la ADR 0009 que
ligaban `full` a dos Evaluadores. Conserva D1–D4 y D6–D8: identidad de unidades e
intentos, DAG, gates, capacidad, ownership, writer lock, generaciones,
invalidación, recuperación, paridad y compatibilidad.

En el momento de esta decisión no modificó la activación de `full` o `light`,
los seis roles, el Documentador obligatorio, la disciplina de diagnóstico de
bugs entonces vigente ni las garantías de seguridad e integridad.

## Consecuencias

### Positivas

- La evidencia por unidad sigue siendo atribuible sin convertirla en una suite
  completa repetida.
- La revisión independiente se reserva para riesgos que justifican separación
  real.
- Una decisión arquitectónica y su implementación tienen un solo dueño del
  cierre.
- TDD permite limpiar de inmediato una solución verde sin agregar alcance.

### Negativas

- El plan incorpora dos campos y un catálogo cerrado de riesgos.
- Las DevSessions `full` heredadas conservan excepcionalmente el esquema dual
  anterior hasta cerrarse o completar su upgrade explícito.
- La estrategia combinada exige que un solo reporte distinga claramente los
  hallazgos de Estándares y Especificación.

## Validación

Las pruebas permanentes de la CLI cubren el default combinado, el rechazo de
dual sin riesgo válido, la apertura de ambos tipos de eje, el cierre por todos
los ejes requeridos, la invalidación de aprobaciones obsoletas y el upgrade
compatible. Las pruebas estructurales verifican el cierre único de
`architecture`, la validación completa única, las reglas TDD y la ausencia de la
regla anterior por modo.
