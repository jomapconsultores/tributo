"""Lectura de documentos con IA (Claude) para el catálogo de proveedores calificados.

Lee certificados/documentos (PDF, foto/imagen o Excel) del Ministerio de Producción
/ SRI y extrae: RUC, razón social, si está calificado (MIPYME/artesano), categoría y
vigencia (inicio–fin). Requiere ANTHROPIC_API_KEY en el entorno; si no está, devuelve
None y el llamador usa el respaldo por texto/regex.
"""
import base64
import json
import os
import re

MODELO = "claude-opus-4-8"

PROMPT = (
    "Eres un asistente que extrae datos de certificados/documentos de proveedores del "
    "Ministerio de Producción o del SRI de Ecuador. Del documento adjunto extrae:\n"
    "- ruc: el RUC (13 dígitos) del proveedor. Vacío si no aparece.\n"
    "- nombre: razón social o nombre del proveedor/empresa.\n"
    "- calificado: true si está categorizado/calificado como MIPYME, microempresa, "
    "pequeña empresa, mediana empresa, artesano u organización de economía popular y "
    "solidaria; false si dice NO MIPYME o no está categorizado.\n"
    "- categoria: la categoría textual (ej. MICROEMPRESA, PEQUEÑA EMPRESA, ARTESANO). Vacío si no hay.\n"
    "- vigencia_inicio: fecha de inicio de vigencia en formato YYYY-MM-DD. Vacío si no hay.\n"
    "- vigencia_fin: fecha de fin/hasta de vigencia en formato YYYY-MM-DD. Vacío si no hay.\n\n"
    "Responde ÚNICAMENTE con un objeto JSON con esas seis claves, sin texto adicional ni explicación."
)


def disponible():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _media_image(name):
    n = (name or "").lower()
    if n.endswith(".png"):
        return "image/png"
    if n.endswith(".webp"):
        return "image/webp"
    if n.endswith(".gif"):
        return "image/gif"
    return "image/jpeg"


def _parse_json(texto):
    if not texto:
        return None
    m = re.search(r"\{.*\}", texto, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def _norm_fecha(v):
    s = str(v or "").strip()
    if not s:
        return None
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.match(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", s)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return None


def leer_documento_ia(content, filename, content_type, texto=None):
    """Devuelve dict {ruc,nombre,calificado,categoria,vigencia_inicio,vigencia_fin}
    o None si no se pudo (sin API key, error, o sin datos)."""
    if not disponible():
        return None
    try:
        import anthropic
    except Exception:
        return None
    name = (filename or "").lower()
    ctype = (content_type or "").lower()
    bloque = None
    if name.endswith(".pdf") or "pdf" in ctype:
        bloque = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                 "data": base64.standard_b64encode(content).decode()}}
    elif name.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")) or ctype.startswith("image/"):
        bloque = {"type": "image", "source": {"type": "base64", "media_type": _media_image(name),
                                              "data": base64.standard_b64encode(content).decode()}}
    elif texto:
        bloque = {"type": "text", "text": "Contenido del documento:\n" + texto[:8000]}
    else:
        return None
    try:
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model=MODELO, max_tokens=1024,
            messages=[{"role": "user", "content": [bloque, {"type": "text", "text": PROMPT}]}],
        )
        txt = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        d = _parse_json(txt)
        if not d:
            return None
        return {
            "ruc": re.sub(r"\D", "", str(d.get("ruc") or "")),
            "nombre": (str(d.get("nombre") or "")).strip(),
            "calificado": bool(d.get("calificado")),
            "categoria": (str(d.get("categoria") or "")).strip(),
            "vigencia_inicio": _norm_fecha(d.get("vigencia_inicio")),
            "vigencia_fin": _norm_fecha(d.get("vigencia_fin")),
        }
    except Exception as e:
        print(f"leer_documento_ia: {e}")
        return None
