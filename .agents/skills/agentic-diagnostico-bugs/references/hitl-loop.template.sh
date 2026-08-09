#!/usr/bin/env bash
# Esqueleto de bucle HITL para `agentic-diagnostico-bugs`.
#
# El contrato completo vive en `hitl-loop.template.md`; este archivo solo lo
# materializa. Usar únicamente cuando la reproducción exija una acción humana
# que el agente no pueda automatizar. Copiar, editar el bloque marcado, ejecutar
# y registrar el script temporal en la DevSession:
#
#   bash hitl-loop.template.sh
#
# `step`    muestra una acción y espera confirmación; no captura su contenido.
#           Autenticación, credenciales y secretos van siempre aquí.
# `capture` guarda una observación redactada que ayude a decidir pasa/falla.
#
# Abortar en cualquier momento con Ctrl-C: no se pierde contexto, el estado
# vive en la DevSession.

set -euo pipefail

PASO=0
CLAVES=()

step() {
  PASO=$((PASO + 1))
  printf '\n[%d] %s\n' "$PASO" "$1"
  read -r -p "    [Enter al terminar] " _
}

capture() {
  local clave="$1" pregunta="$2" respuesta
  PASO=$((PASO + 1))
  printf '\n[%d] %s\n' "$PASO" "$pregunta"
  read -r -p "    > " respuesta
  printf -v "$clave" '%s' "$respuesta"
  CLAVES+=("$clave")
}

# --- editar debajo -----------------------------------------------------------

step "Abrir el entorno indicado y dejarlo en el estado previo al síntoma."

capture SINTOMA "¿Apareció el síntoma exacto? Responder si/no."

capture DETALLE "Describir solo la observación relevante, sin secretos."

# --- editar encima -----------------------------------------------------------

printf '\n--- Capturado ---\n'
for clave in ${CLAVES[@]+"${CLAVES[@]}"}; do
  printf '%s=%s\n' "$clave" "${!clave}"
done
