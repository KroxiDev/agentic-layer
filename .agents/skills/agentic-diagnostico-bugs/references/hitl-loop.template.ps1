#Requires -Version 5.1
<#
    Esqueleto de bucle HITL para `agentic-diagnostico-bugs`.

    El contrato completo vive en `hitl-loop.template.md`; este archivo solo lo
    materializa. Usar únicamente cuando la reproducción exija una acción humana
    que el agente no pueda automatizar. Copiar, editar el bloque marcado,
    ejecutar y registrar el script temporal en la DevSession:

        powershell -ExecutionPolicy Bypass -File hitl-loop.template.ps1

    Step    muestra una acción y espera confirmación; no captura su contenido.
            Autenticación, credenciales y secretos van siempre aquí.
    Capture guarda una observación redactada que ayude a decidir pasa/falla.

    Abortar en cualquier momento con Ctrl-C: no se pierde contexto, el estado
    vive en la DevSession.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Paso = 0
$script:Capturado = [ordered]@{}

function Step {
    param([Parameter(Mandatory = $true)][string]$Instruccion)

    $script:Paso++
    Write-Host ""
    Write-Host "[$script:Paso] $Instruccion"
    Read-Host "    [Enter al terminar]" | Out-Null
}

function Capture {
    param(
        [Parameter(Mandatory = $true)][string]$Clave,
        [Parameter(Mandatory = $true)][string]$Pregunta
    )

    $script:Paso++
    Write-Host ""
    Write-Host "[$script:Paso] $Pregunta"
    $script:Capturado[$Clave] = Read-Host "    >"
}

# --- editar debajo -----------------------------------------------------------

Step "Abrir el entorno indicado y dejarlo en el estado previo al síntoma."

Capture -Clave 'SINTOMA' -Pregunta '¿Apareció el síntoma exacto? Responder si/no.'

Capture -Clave 'DETALLE' -Pregunta 'Describir solo la observación relevante, sin secretos.'

# --- editar encima -----------------------------------------------------------

Write-Host ""
Write-Host "--- Capturado ---"
foreach ($clave in $script:Capturado.Keys) {
    Write-Host ("{0}={1}" -f $clave, $script:Capturado[$clave])
}
