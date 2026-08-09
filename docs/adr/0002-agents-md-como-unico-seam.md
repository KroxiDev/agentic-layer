# `AGENTS.md` como único seam de configuración

Todo lo que un proyecto necesita declarar para que la capa funcione vive en un
bloque delimitado de `AGENTS.md`, en prosa Markdown. Elegimos esto en lugar de un
archivo de configuración propio porque el consumidor real de esas reglas es un
modelo de lenguaje leyendo el archivo que las plataformas ya cargan por sí
solas: un `.agentsrc.json` obligaría a mantener un lector, un esquema y un
mecanismo de inyección de sus valores en el prompt, sin ganar nada que la prosa
no dé.

## Consecuencias

Los adapters (`.codex/`, `.claude/`, `CLAUDE.md`) quedan deliberadamente
delgados: sólo restricciones técnicas y punteros a rutas canónicas, nunca hechos
del proyecto ni copias de las políticas. La interface es tan pequeña que un
proyecto normal no edita nada más, y por eso el inicializador puede reemplazar
todo el resto sin consultar.

El precio es que el «esquema» del contrato se valida por reconocimiento de
etiquetas y no por tipos: los campos se identifican por alias normalizados de sus
títulos, y cualquier valor con forma `<…>` cuenta como ausente. Es una
comprobación deliberadamente laxa en la forma y estricta en la completitud.
