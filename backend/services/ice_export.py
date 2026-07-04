import io
from typing import List, Dict
import pandas as pd
from services.ice_calc import audit_detail, resumen_por_producto, resumen_general
from services.ice_data import tax_params
from services.ice_anexo import grupo_por_producto, grupo_por_cliente
from services.xlsx_styles import ice_formats
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib import colors


def generate_ice_pdf(rows: List[Dict], anio: str, cliente=None) -> bytes:
    rows_ok = [r for r in rows if r.get("estado") != "DUPLICADO"]
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=landscape(letter))
    st = getSampleStyleSheet()
    money = lambda v: f"${float(v or 0):,.2f}"
    label = f"{(cliente or {}).get('identificacion','')} - {(cliente or {}).get('nombre','')}"
    story = [Paragraph("Reporte ICE", st['Title']),
             Paragraph(f"Contribuyente: {label} · Año {anio}", st['Normal']),
             Spacer(1, 0.2 * inch)]

    def tabla(data, aligns_right_from=1):
        t = Table(data, repeatRows=1)
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1a5276')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('ALIGN', (aligns_right_from, 0), (-1, -1), 'RIGHT'),
        ]))
        return t

    # Reporte general (auditoría por producto) — audit_detail se calcula una
    # sola vez y se reutiliza en ambos resúmenes.
    det = audit_detail(rows_ok, anio)
    story.append(Paragraph("Reporte general (auditoría por producto)", st['Heading2']))
    d = [["Producto", "Botellas", "Subtotal", "ICE Esp.", "ICE AdV", "Total ICE", "Base IVA", "IVA"]]
    for f in resumen_por_producto(rows_ok, anio, det=det):
        d.append([f["producto"][:34], f"{f['botellas']:.0f}", money(f["subtotal"]), money(f["ice_especifico"]),
                  money(f["ice_advalorem"]), money(f["total_ice"]), money(f["base_iva"]), money(f["iva"])])
    g = resumen_general(rows_ok, anio, det=det)
    d.append(["TOTAL", "", money(g["subtotal"]), money(g["ice_especifico"]), money(g["ice_advalorem"]),
              money(g["total_ice"]), money(g["base_iva"]), money(g["iva"])])
    story.append(tabla(d, 1)); story.append(Spacer(1, 0.22 * inch))

    # Cuadro por producto
    story.append(Paragraph("Cuadro por producto", st['Heading2']))
    d2 = [["Producto", "Cajas", "Botellas", "Base ICE", "ICE", "Base IVA", "IVA", "Total"]]
    for p in grupo_por_producto(rows_ok):
        d2.append([p["producto"][:34], f"{p['cajas']:.0f}", str(p["botellas"]), money(p["base_ice"]),
                   money(p["valor_ice"]), money(p["base_iva"]), money(p["valor_iva"]), money(p["total"])])
    story.append(tabla(d2, 1)); story.append(Spacer(1, 0.22 * inch))

    # Cuadro por cliente
    story.append(Paragraph("Cuadro por cliente", st['Heading2']))
    d3 = [["RUC", "Cliente", "Botellas", "Base ICE", "ICE", "IVA", "Total"]]
    for c in grupo_por_cliente(rows_ok):
        d3.append([c["ruc"], c["nombre"][:30], str(c["botellas"]), money(c["base_ice"]),
                   money(c["valor_ice"]), money(c["valor_iva"]), money(c["total"])])
    story.append(tabla(d3, 2))

    doc.build(story)
    output.seek(0)
    return output.getvalue()


def generate_ice_excel(rows: List[Dict], anio: str) -> bytes:
    """Excel de auditoría ICE con 3 hojas: Auditoría por Producto, Resumen ICE
    y Resumen General. Replica ICEcompleto(1).py (valores ya calculados)."""
    tax = tax_params(anio)
    output = io.BytesIO()
    try:
        with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
            wb = writer.book
            fmt = ice_formats(wb)
            head, money, num4, pct, cell, tot, tot_lbl = (
                fmt["head"], fmt["money"], fmt["num4"], fmt["pct"], fmt["cell"], fmt["tot"], fmt["tot_lbl"])

            # -------- Hoja 1: Auditoría por Producto --------
            ws = wb.add_worksheet("Auditoría por Producto")
            ws.write(0, 0, f"AUDITORÍA ICE {anio} — Tarifa Esp: {tax['esp']} · Umbral: {tax['umb']} · IVA: {int(tax['iva']*100)}%",
                     fmt['title'])
            cols = ["#", "Fecha", "Cliente", "Producto Original", "Pack", "Producto Individual",
                    "Botellas", "Grado %", "Volumen cc", "Precio/Bot", "Precio/Litro", "Aplica AdV",
                    "ICE Específico", "ICE Ad-Valorem", "Total ICE", "Subtotal", "Base IVA", "IVA", "PVP Final"]
            hr = 2
            for j, c in enumerate(cols):
                ws.write(hr, j, c, head)
            det = audit_detail(rows, anio)
            r = hr + 1
            for d in det:
                vals = [d["n"], d["fecha"], d["cliente"][:35], d["producto_original"][:40],
                        "SÍ" if d["es_pack"] else "NO", d["producto_individual"][:40],
                        d["botellas"], d["grado"], d["volumen"], d["precio_botella"], d["precio_litro"],
                        "SÍ" if d["aplica_adv"] else "NO", d["ice_especifico"], d["ice_advalorem"],
                        d["total_ice"], d["subtotal"], d["base_iva"], d["iva"], d["pvp"]]
                for j, v in enumerate(vals):
                    celda_fmt = cell
                    if j in (9, 10):
                        celda_fmt = num4
                    elif j in (12, 13, 14):
                        celda_fmt = num4
                    elif j in (15, 16, 17, 18):
                        celda_fmt = money
                    ws.write(r, j, v, celda_fmt)
                r += 1
            # Totales
            if det:
                ws.write(r, 0, "TOTALES", tot_lbl)
                for j in range(1, len(cols)):
                    ws.write(r, j, "", tot_lbl)
                for j in (12, 13, 14, 15, 16, 17, 18):
                    col = chr(65 + j)
                    ws.write_formula(r, j, f"=SUM({col}{hr+2}:{col}{r})", tot)
            ws.set_column(0, 0, 5)
            ws.set_column(2, 3, 28)
            ws.set_column(5, 5, 26)
            ws.set_column(6, 18, 13)

            # -------- Hoja 2: Resumen ICE --------
            ws2 = wb.add_worksheet("Resumen ICE")
            ws2.write(0, 0, f"RESUMEN ICE {anio}", fmt['title'])
            heads2 = ["Producto", "Botellas", "Subtotal", "ICE Específico", "ICE Ad-Valorem",
                      "Total ICE", "Base IVA", "IVA", "Aplica AdV"]
            for j, c in enumerate(heads2):
                ws2.write(2, j, c, head)
            filas = resumen_por_producto(rows, anio, det=det)
            rr = 3
            for f in filas:
                vals = [f["producto"], f["botellas"], f["subtotal"], f["ice_especifico"],
                        f["ice_advalorem"], f["total_ice"], f["base_iva"], f["iva"],
                        "SÍ" if f["aplica_adv"] else "NO"]
                for j, v in enumerate(vals):
                    ws2.write(rr, j, v, money if j in (2, 3, 4, 5, 6, 7) else cell)
                rr += 1
            if filas:
                ws2.write(rr, 0, "TOTAL GENERAL", tot_lbl)
                for j in range(1, 9):
                    if j in (1, 2, 3, 4, 5, 6, 7):
                        col = chr(65 + j)
                        ws2.write_formula(rr, j, f"=SUM({col}4:{col}{rr})", tot)
                    else:
                        ws2.write(rr, j, "", tot_lbl)
            ws2.set_column(0, 0, 42)
            ws2.set_column(1, 8, 15)

            # -------- Hoja 3: Resumen General --------
            ws3 = wb.add_worksheet("Resumen General")
            ws3.write(0, 0, f"RESUMEN GENERAL — ICE {anio}", fmt['title'])
            g = resumen_general(rows, anio, det=det)
            heads3 = ["Concepto", "Subtotal", "ICE Específico", "ICE Ad-Valorem", "Total ICE", "Base IVA", "IVA", "Total General"]
            for j, c in enumerate(heads3):
                ws3.write(2, j, c, head)
            vals3 = ["TOTAL VENTAS BEBIDAS ALCOHÓLICAS", g["subtotal"], g["ice_especifico"],
                     g["ice_advalorem"], g["total_ice"], g["base_iva"], g["iva"], g["pvp"]]
            for j, v in enumerate(vals3):
                ws3.write(3, j, v, money if j >= 1 else wb.add_format({'bold': True, 'border': 1}))
            ws3.write(5, 0, f"Líneas auditadas: {g['lineas']}", wb.add_format({'italic': True}))
            ws3.set_column(0, 0, 36)
            ws3.set_column(1, 7, 18)

        output.seek(0)
        return output.getvalue()
    except Exception as e:
        print(f"Error in generate_ice_excel: {e}")
        return b""
