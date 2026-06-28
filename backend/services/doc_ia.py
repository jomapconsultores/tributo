"""Lectura de documentos con IA (Mistral) para el catálogo de proveedores calificados.

Lee certificados/documentos (PDF, foto/imagen o Excel) y extrae: RUC, razón social,
si está calificado (MIPYME/artesano), categoría y vigencia (inicio–fin).
Flujo: Mistral OCR para sacar el texto del documento (fotos/escaneos incluidos) y luego
Mistral chat para estructurarlo en JSON. Requiere MISTRAL_API_KEY en el entorno; si no
está, devuelve None y el llamador usa el respaldo por texto/regex + Ministerio.
"""
import base64
import json
import os
import re

import requests

OCR_URL = "https://api.mistral.ai/v1/ocr"
CHAT_URL = "https://api.mistral.ai/v1/chat/completions"
OCR_MODEL = "mistral-ocr-latest"
CHAT_MODEL = "mistral-small-latest"

PROMPT = (
    "Del siguiente texto de un certificado/documento de un proveedor del Ministerio de "
    "Producción o del SRI de Ecuador, extrae estos campos y responde SOLO en JSON:\n"
    '{"ruc": "RUC de 13 dígitos o vacío", '
    '"nombre": "razón social o nombre", '
    '"calificado": true si está categorizado/calificado como MIPYME, microempresa, pequeña '
    "o mediana empresa, artesano u organización de economía popular y solidaria; false si dice "
    'NO MIPYME o no está categorizado, '
    '"categoria": "categoría textual (ej. MICROEMPRESA, PEQUEÑA EMPRESA, ARTESANO) o vacío", '
    '"vigencia_inicio": "fecha inicio YYYY-MM-DD o vacío", '
    '"vigencia_fin": "fecha fin/hasta YYYY-MM-DD o vacío"}\n\nTEXTO:\n'
)


def disponible():
    return bool(os.environ.get("MISTRAL_API_KEY"))


def _media_image(name):
    n = (name or "").lower()
    if n.endswith(".png"):
        return "image/png"
    if n.endswith(".webp"):
        return "image/webp"
    if n.endswith(".gif"):
        return "image/gif"
    return "image/jpeg"


def _ocr(content, filename, content_type, key):
    """Devuelve el texto (markdown) del documento usando Mistral OCR."""
    name = (filename or "").lower()
    ctype = (content_type or "").lower()
    b64 = base64.standard_b64encode(content).decode()
    if name.endswith(".pdf") or "pdf" in ctype:
        doc = {"type": "document_url", "document_url": f"data:application/pdf;base64,{b64}"}
    else:
        doc = {"type": "image_url", "image_url": f"data:{_media_image(name)};base64,{b64}"}
    r = requests.post(OCR_URL, timeout=120,
                      headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                      json={"model": OCR_MODEL, "document": doc})
    r.raise_for_status()
    data = r.json()
    return "\n".join((p.get("markdown") or "") for p in (data.get("pages") or []))


def _chat_json(texto, key):
    r = requests.post(CHAT_URL, timeout=60,
                      headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                      json={"model": CHAT_MODEL, "temperature": 0,
                            "response_format": {"type": "json_object"},
                            "messages": [{"role": "user", "content": PROMPT + texto[:12000]}]})
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _norm_fecha(v):
    s = str(v or "").strip()
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.match(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", s)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return None


def leer_documento_ia(content, filename, content_type, texto=None):
    """Devuelve dict {ruc,nombre,calificado,categoria,vigencia_inicio,vigencia_fin} o None."""
    key = os.environ.get("MISTRAL_API_KEY")
    if not key:
        return None
    try:
        name = (filename or "").lower()
        ctype = (content_type or "").lower()
        es_doc = name.endswith(".pdf") or "pdf" in ctype or name.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")) or ctype.startswith("image/")
        txt = _ocr(content, filename, content_type, key) if es_doc else (texto or "")
        if not (txt or "").strip():
            return None
        out = _chat_json(txt, key)
        d = json.loads(re.search(r"\{.*\}", out, re.S).group(0)) if out else None
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
        print(f"leer_documento_ia (mistral): {e}")
        return None
