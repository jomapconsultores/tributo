"""Formatos xlsxwriter compartidos entre módulos de exportación ICE
(ice_export.py, ice_calc_export.py, anexo_export.py comparten el mismo estilo
de encabezado/título/celda; antes cada uno redeclaraba los mismos formatos por
separado). retention_export.py y export_service.py tienen su propia paleta
(azul #007bff, montos con signo $) y no se tocan aquí."""

AZUL = "#1a5276"
VERDE = "#27ae60"


def ice_formats(wb):
    """Paleta usada por los reportes ICE (auditoría/resumen): encabezado azul,
    totales en verde, celdas/montos genéricos."""
    return {
        "head": wb.add_format({"bold": True, "bg_color": AZUL, "font_color": "white",
                                "border": 1, "align": "center", "text_wrap": True}),
        "money": wb.add_format({"num_format": "#,##0.00", "border": 1}),
        "num4": wb.add_format({"num_format": "#,##0.0000", "border": 1}),
        "pct": wb.add_format({"num_format": "0.00%", "border": 1}),
        "cell": wb.add_format({"border": 1}),
        "tot": wb.add_format({"bold": True, "bg_color": VERDE, "font_color": "white",
                               "border": 1, "num_format": "#,##0.00"}),
        "tot_lbl": wb.add_format({"bold": True, "bg_color": VERDE, "font_color": "white", "border": 1}),
        "title": wb.add_format({"bold": True, "font_color": AZUL, "font_size": 13}),
    }


def title_format(wb):
    """Formato de título usado en varios módulos de exportación (ICE, anexo)."""
    return wb.add_format({"bold": True, "font_color": AZUL, "font_size": 13})
