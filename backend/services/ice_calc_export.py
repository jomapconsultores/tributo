import io
from services.ice_calc_report import enrich, por_categoria, por_producto, general
from services.ice_calc_data import CAT_LABEL, tarifas_anio, iva_rate
from services.xlsx_styles import ice_formats
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib import colors


def _label_cliente(cliente):
    if not cliente:
        return ""
    return f"{cliente.get('identificacion','')} - {cliente.get('nombre','')}"


def generate_calc_excel(rows, anio, mes, cliente=None) -> bytes:
    import pandas as pd
    filas = enrich(rows, anio, mes)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
        wb = writer.book
        fmt = ice_formats(wb)
        head, money, cell, tot, totlbl = fmt["head"], fmt["money"], fmt["cell"], fmt["tot"], fmt["tot_lbl"]

        # Hoja Detalle
        ws = wb.add_worksheet("Detalle")
        ws.write(0, 0, f"CÁLCULO ICE — {_label_cliente(cliente)} — {mes}/{anio} (IVA {int(iva_rate(anio, mes)*100)}%)",
                 fmt["title"])
        cols = ["Producto", "Categoría", "Por cajas", "Cajas", "Bot/Caja", "Botellas",
                "Grado %", "Cap. ml", "Precio", "$/Bot", "ICE Específico", "ICE Ad-Valorem",
                "Total ICE", "Subtotal", "Base IVA", "IVA", "PVP"]
        for j, c in enumerate(cols):
            ws.write(2, j, c, head)
        r = 3
        for d in filas:
            vals = [d.get("producto", ""), CAT_LABEL.get(d["categoria"], d["categoria"]),
                    "Sí" if d.get("por_cajas") else "No", d.get("cajas", 0), d.get("botellas_por_caja", 0),
                    d["total_botellas"], d.get("grado", 0), d.get("capacidad", 0), d.get("precio", 0),
                    d["precio_botella"], d["ice_especifico"], d["ice_advalorem"], d["total_ice"],
                    d["subtotal"], d["base_iva"], d["iva"], d["pvp"]]
            for j, v in enumerate(vals):
                ws.write(r, j, v, money if j >= 9 else cell)
            r += 1
        if filas:
            ws.write(r, 0, "TOTALES", totlbl)
            for j in range(1, len(cols)):
                ws.write(r, j, "", totlbl)
            for j in (10, 11, 12, 13, 14, 15, 16):
                col = chr(65 + j)
                ws.write_formula(r, j, f"=SUM({col}4:{col}{r})", tot)
        ws.set_column(0, 0, 26)
        ws.set_column(1, 1, 18)
        ws.set_column(2, 16, 12)

        # Hoja por Categoría
        ws2 = wb.add_worksheet("Por Categoría")
        h2 = ["Categoría", "# Prod", "Botellas", "Subtotal", "ICE Específico", "ICE Ad-Valorem", "Total ICE", "Base IVA", "IVA", "PVP"]
        for j, c in enumerate(h2):
            ws2.write(0, j, c, head)
        rr = 1
        for f in por_categoria(filas):
            vals = [f["label"], f["num"], f["botellas"], f["subtotal"], f["ice_especifico"],
                    f["ice_advalorem"], f["total_ice"], f["base_iva"], f["iva"], f["pvp"]]
            for j, v in enumerate(vals):
                ws2.write(rr, j, v, money if j >= 3 else cell)
            rr += 1
        g = general(filas)
        ws2.write(rr, 0, "TOTAL GENERAL", totlbl)
        for j, key in enumerate(["", "num", "botellas", "subtotal", "ice_especifico", "ice_advalorem", "total_ice", "base_iva", "iva", "pvp"]):
            if j == 0:
                continue
            ws2.write(rr, j, g.get(key, 0), tot)
        ws2.set_column(0, 0, 24)
        ws2.set_column(1, 9, 14)

        # Hoja por Producto
        ws3 = wb.add_worksheet("Por Producto")
        h3 = ["Producto", "Categoría", "# ", "Botellas", "Subtotal", "Total ICE", "Base IVA", "IVA", "PVP"]
        for j, c in enumerate(h3):
            ws3.write(0, j, c, head)
        r3 = 1
        for f in por_producto(filas):
            vals = [f["producto"], f["label"], f["num"], f["botellas"], f["subtotal"], f["total_ice"], f["base_iva"], f["iva"], f["pvp"]]
            for j, v in enumerate(vals):
                ws3.write(r3, j, v, money if j >= 4 else cell)
            r3 += 1
        ws3.set_column(0, 0, 28)
        ws3.set_column(1, 1, 18)
        ws3.set_column(2, 8, 13)

    output.seek(0)
    return output.getvalue()


def generate_calc_pdf(rows, anio, mes, cliente=None) -> bytes:
    filas = enrich(rows, anio, mes)
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=landscape(letter))
    styles = getSampleStyleSheet()
    story = [Paragraph(f"Cálculo ICE — {_label_cliente(cliente)}", styles['Title']),
             Paragraph(f"Período {mes}/{anio} · IVA {int(iva_rate(anio, mes)*100)}%", styles['Normal']),
             Spacer(1, 0.2 * inch)]

    money = lambda v: f"${float(v or 0):,.2f}"

    # Por categoría
    story.append(Paragraph("Resumen por categoría", styles['Heading2']))
    data = [["Categoría", "# Prod", "Subtotal", "ICE Específico", "ICE Ad-Valorem", "Total ICE", "Base IVA", "IVA", "PVP"]]
    for f in por_categoria(filas):
        data.append([f["label"], str(f["num"]), money(f["subtotal"]), money(f["ice_especifico"]),
                     money(f["ice_advalorem"]), money(f["total_ice"]), money(f["base_iva"]), money(f["iva"]), money(f["pvp"])])
    g = general(filas)
    data.append(["TOTAL GENERAL", str(g["num"]), money(g["subtotal"]), money(g["ice_especifico"]),
                 money(g["ice_advalorem"]), money(g["total_ice"]), money(g["base_iva"]), money(g["iva"]), money(g["pvp"])])
    t = Table(data, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a5276')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
        ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#d5f5e3')),
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
    ]))
    story.append(t)
    story.append(Spacer(1, 0.25 * inch))

    # Por producto
    story.append(Paragraph("Detalle por producto", styles['Heading2']))
    d2 = [["Producto", "Categoría", "Botellas", "Subtotal", "Total ICE", "Base IVA", "IVA", "PVP"]]
    for f in por_producto(filas):
        d2.append([f["producto"][:34], f["label"], f"{f['botellas']:.0f}", money(f["subtotal"]),
                   money(f["total_ice"]), money(f["base_iva"]), money(f["iva"]), money(f["pvp"])])
    t2 = Table(d2, repeatRows=1)
    t2.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a5276')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 7),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('ALIGN', (2, 0), (-1, -1), 'RIGHT'),
    ]))
    story.append(t2)

    doc.build(story)
    output.seek(0)
    return output.getvalue()
