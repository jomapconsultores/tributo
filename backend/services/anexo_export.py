"""Exportación del Anexo PVP+ICE (cabecera + detalle de ventas) a Excel y PDF."""
import io
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib import colors
from services.xlsx_styles import ice_formats

COLS = {
    "ICE": ["codProdICE", "gramoAzucar", "tipoIdCliente", "idCliente",
            "tipoVentaICE", "ventaICE", "devICE", "cantProdBajaICE"],
    "PVP": ["codProdPVP", "gramoAzucar", "precioExPVP", "precioPVP",
            "fechaInPVP", "fechaFinPVP"],
}
HEADER_FIELDS = {
    "ICE": ["TipoIDInformante", "IdInformante", "razonSocial", "Anio", "Mes", "actImport", "codigoOperativo"],
    "PVP": ["TipoIDInformante", "IdInformante", "razonSocial", "Anio", "Mes", "tipoCarga", "codigoOperativo"],
}
ETIQUETAS = {
    "TipoIDInformante": "Tipo ID Informante", "IdInformante": "RUC Informante",
    "razonSocial": "Razón Social", "Anio": "Año", "Mes": "Mes",
    "actImport": "Actividad (actImport)", "tipoCarga": "Tipo de Carga",
    "codigoOperativo": "Código Operativo",
    "codProdICE": "Código Producto ICE", "codProdPVP": "Código Producto PVP",
    "gramoAzucar": "Gramos Azúcar", "tipoIdCliente": "Tipo ID Cliente",
    "idCliente": "ID Cliente", "tipoVentaICE": "Tipo Venta",
    "ventaICE": "Venta ICE (botellas)", "devICE": "Devoluciones",
    "cantProdBajaICE": "Prod. de Baja", "precioExPVP": "Precio Ex-Fábrica",
    "precioPVP": "Precio PVP", "fechaInPVP": "Fecha Inicio", "fechaFinPVP": "Fecha Fin",
    "nombreProducto": "Producto",
}


def _columnas(tipo, rows):
    cols = list(COLS.get(tipo, COLS["ICE"]))
    if any((r or {}).get("nombreProducto") for r in rows):
        cols.append("nombreProducto")
    return cols


def generar_anexo_excel(tipo: str, header: dict, rows: list) -> bytes:
    """Excel del anexo: bloque de cabecera del contribuyente + tabla de detalle."""
    import xlsxwriter
    tipo = (tipo or "ICE").upper()
    output = io.BytesIO()
    wb = xlsxwriter.Workbook(output, {"in_memory": True})
    fmt = ice_formats(wb)
    title_fmt, head, cell, num = fmt["title"], fmt["head"], fmt["cell"], fmt["money"]
    lbl = wb.add_format({"bold": True, "bg_color": "#eaf2f8", "border": 1})  # estilo propio de este anexo
    val = wb.add_format({"border": 1})

    ws = wb.add_worksheet(f"Anexo {tipo}")
    ws.write(0, 0, f"ANEXO {tipo} — {header.get('Anio', '')}/{str(header.get('Mes', '')).zfill(2)}", title_fmt)

    r = 2
    for campo in HEADER_FIELDS.get(tipo, HEADER_FIELDS["ICE"]):
        ws.write(r, 0, ETIQUETAS.get(campo, campo), lbl)
        ws.write(r, 1, str(header.get(campo, "") or ""), val)
        r += 1

    r += 1
    cols = _columnas(tipo, rows)
    for j, c in enumerate(cols):
        ws.write(r, j, ETIQUETAS.get(c, c), head)
    numericos = {"ventaICE", "devICE", "cantProdBajaICE", "precioExPVP", "precioPVP", "gramoAzucar"}
    for fila in rows:
        r += 1
        for j, c in enumerate(cols):
            v = (fila or {}).get(c, "")
            if c in numericos:
                try:
                    ws.write_number(r, j, float(v or 0), num)
                    continue
                except (TypeError, ValueError):
                    pass
            ws.write(r, j, str(v or ""), cell)
    ws.set_column(0, 0, 40)
    ws.set_column(1, len(cols) - 1, 16)
    if "nombreProducto" in cols:
        ws.set_column(len(cols) - 1, len(cols) - 1, 42)
    wb.close()
    output.seek(0)
    return output.getvalue()


def generar_anexo_pdf(tipo: str, header: dict, rows: list) -> bytes:
    """PDF del anexo: datos del contribuyente + tabla de detalle de ventas."""
    tipo = (tipo or "ICE").upper()
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=landscape(letter))
    st = getSampleStyleSheet()
    story = [
        Paragraph(f"Anexo {tipo} — SRI", st["Title"]),
        Paragraph(
            f"{header.get('IdInformante', '')} — {header.get('razonSocial', '')} · "
            f"Período {header.get('Anio', '')}/{str(header.get('Mes', '')).zfill(2)}",
            st["Normal"]),
        Spacer(1, 0.15 * inch),
    ]

    hdata = [[ETIQUETAS.get(c, c), str(header.get(c, "") or "")]
             for c in HEADER_FIELDS.get(tipo, HEADER_FIELDS["ICE"])]
    th = Table(hdata, colWidths=[2.2 * inch, 4.2 * inch])
    th.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eaf2f8")),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ]))
    story.extend([th, Spacer(1, 0.25 * inch),
                  Paragraph(f"Detalle de productos (ventas) — {len(rows)} fila(s)", st["Heading2"])])

    cols = _columnas(tipo, rows)
    data = [[ETIQUETAS.get(c, c) for c in cols]]
    for fila in rows:
        data.append([str((fila or {}).get(c, "") or "") for c in cols])
    td = Table(data, repeatRows=1)
    td.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a5276")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 6.5),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ]))
    story.append(td)
    doc.build(story)
    output.seek(0)
    return output.getvalue()
