"""Parser de facturas de VENTA (ingresos) desde el PDF (RIDE del SRI).

Se usa cuando el XML no está disponible (ej. facturas emitidas por el FACTURADOR
del SRI, que bloquea la descarga del XML). Lee el texto del RIDE y extrae los
mismos campos que `parse_venta_xml`, para guardarse en `sales_iva` de igual forma.

La lectura del PDF puede variar según el emisor; por eso el módulo permite editar
los valores luego. Si la factura tiene ICE, se rechaza (debe ir a "ICE - XML").
"""
import io
import re
from typing import Dict, Optional

import PyPDF2


def _texto_pdf(pdf_bytes: bytes) -> str:
    reader = PyPDF2.PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def _num_antes(texto: str, etiqueta: str) -> float:
    """Número (####.##) que aparece justo ANTES de la etiqueta dada.
    Robusto ante números pegados (ej. '69.0060.00 SUBTOTAL 15%' → 60.00)."""
    # Lookahead (?=\s|$): la etiqueta debe terminar en espacio/fin (cubre que
    # termine en '%', donde \b no funciona).
    m = re.search(r"(\d+\.\d{2})\s*" + re.escape(etiqueta) + r"(?=\s|$)", texto)
    return float(m.group(1)) if m else 0.0


def _tipo_id(identificacion: str) -> str:
    """Código SRI de tipo de identificación del comprador, por longitud."""
    n = len(identificacion or "")
    if n == 13:
        return "04"   # RUC
    if n == 10:
        return "05"   # cédula
    if n >= 1:
        return "06"   # pasaporte / otro
    return "07"       # consumidor final


def parse_venta_pdf(pdf_bytes: bytes) -> Optional[Dict]:
    """Devuelve el mismo dict que parse_venta_xml (para sales_iva), o
    {'error': 'CON_ICE'} si la factura tiene ICE, o None si no se pudo leer."""
    try:
        texto = _texto_pdf(pdf_bytes)
    except Exception:
        return None
    if not texto or not texto.strip():
        return None
    t = re.sub(r"[ \t]+", " ", texto)

    # ── Identificadores ──────────────────────────────────────────────────
    mclave = re.search(r"\d{49}", t)
    clave = mclave.group(0) if mclave else None

    mnum = re.search(r"(\d{3}-\d{3}-\d{9})", t)
    factura_numero = mnum.group(1) if mnum else None

    # Fecha de emisión: la que está pegada/antes del número; si no, la 1ª del doc.
    fecha = None
    if factura_numero:
        mf = re.search(r"(\d{2}/\d{2}/\d{4})\s*" + re.escape(factura_numero), t)
        if mf:
            fecha = mf.group(1)
    if not fecha:
        mf = re.search(r"\d{2}/\d{2}/\d{4}", t)
        fecha = mf.group(0) if mf else None

    # Comprador: identificación (10-13 dígitos) justo antes de la fecha+número.
    id_cliente = ""
    razon_cliente = "CONSUMIDOR FINAL"
    if factura_numero:
        mc = re.search(r"([A-Za-zÁÉÍÓÚÑáéíóúñ .,&'\-]{3,70}?)\s*\n?\s*(\d{10,13})\s*\d{2}/\d{2}/\d{4}\s*"
                       + re.escape(factura_numero), texto)
        if mc:
            id_cliente = mc.group(2)
            nombre = re.sub(r"(?i)(identificaci[oó]n|fecha gu[ií]a|raz[oó]n social.*?:?)", "", mc.group(1)).strip()
            if nombre:
                razon_cliente = nombre

    unique_id = clave or (f"{id_cliente}-{factura_numero}" if factura_numero else None)
    if not unique_id:
        return None

    # ── Rechazo si tiene ICE ─────────────────────────────────────────────
    ice = _num_antes(t, "ICE")
    if ice > 0:
        return {
            "error": "CON_ICE",
            "message": 'La factura contiene ICE. Subila en "ICE - XML" en vez de "Ingresos IVA".',
            "unique_id": unique_id,
            "factura_numero": factura_numero,
        }

    # ── Totales por tarifa (etiquetas del RIDE) ──────────────────────────
    base_15 = _num_antes(t, "SUBTOTAL 15%")
    base_5 = _num_antes(t, "SUBTOTAL 5%")
    base_0 = _num_antes(t, "SUBTOTAL 0%")
    no_objeto = _num_antes(t, "SUBTOTAL NO OBJETO DE IVA")
    exento = _num_antes(t, "SUBTOTAL EXENTO DE IVA")
    iva_15 = _num_antes(t, "IVA 15%")
    iva_5 = _num_antes(t, "IVA 5%")
    importe_total = _num_antes(t, "VALOR TOTAL")

    return {
        "unique_id": unique_id,
        "estado": "OK",
        "fecha": fecha,
        "tipo_id_cliente": _tipo_id(id_cliente),
        "id_cliente": id_cliente,
        "razon_social_cliente": razon_cliente,
        "factura_numero": factura_numero,
        "no_objeto_iva": round(no_objeto, 2),
        "exento_iva": round(exento, 2),
        "base_0": round(base_0, 2),
        "base_15": round(base_15, 2),
        "iva_15": round(iva_15, 2),
        "base_5": round(base_5, 2),
        "iva_5": round(iva_5, 2),
        "importe_total": round(importe_total, 2),
    }
