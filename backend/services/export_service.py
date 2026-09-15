# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
import pandas as pd
from typing import List, Dict
import io
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib import colors

GASTOS_PERSONALES = {
    "ALIMENTACIÓN", "ALIMENTACION", "EDUCACIÓN", "EDUCACION",
    "SALUD", "VESTIMENTA", "VIVIENDA", "VARIOS", "TURISMO", "ARTE Y CULTURA"
}

# Orden de columnas de la hoja DATOS (idéntico al script de escritorio para que
# las fórmulas SUMIF/COUNTIF de la hoja RESUMEN apunten a las letras correctas).
DATOS_COLS = [
    ("Estado", "estado"),
    ("Fecha", "fecha"),
    ("RUC", "ruc_proveedor"),
    ("Factura", "factura_numero"),
    ("Nombre", "nombre_proveedor"),
    ("Clasificación", "clasificacion"),
    ("Concepto", "concepto"),
    ("Forma Pago", "forma_pago"),
    ("Tarjeta de Crédito", "tarjeta_credito"),
    ("No Objeto IVA", "no_objeto_iva"),
    ("Exento IVA", "exento_iva"),
    ("Base 0%", "base_0"),
    ("Base 15%", "base_15"),
    ("IVA 15%", "iva_15"),
    ("Base 8%", "base_8"),
    ("IVA 8%", "iva_8"),
    ("Base 5%", "base_5"),
    ("IVA 5%", "iva_5"),
    ("Desc. Info", "desc_info"),
    ("Desc. Manual", "desc_manual"),
    ("Total", "total"),
    ("Destinatario", "destinatario"),
    # Marca al FINAL (no altera las letras de columna que usan las fórmulas
    # SUMIF/COUNTIF de RESUMEN, que apuntan a F..S). Indica que la clasificación
    # de ese gasto fue MODIFICADA excepcionalmente para este contribuyente/período.
    ("Excepción", "es_excepcion"),
]

NUMERIC_KEYS = {
    "no_objeto_iva", "exento_iva", "base_0", "base_15", "iva_15",
    "base_8", "iva_8", "base_5", "iva_5", "desc_info", "desc_manual", "total"
}


def generate_excel(invoices: List[Dict]) -> bytes:
    """Genera Excel con hoja DATOS + RESUMEN (Personales/Ejercicio) + PENDIENTES."""
    output = io.BytesIO()

    rows_ok = [inv for inv in invoices if inv.get('estado') == 'OK']

    try:
        with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
            wb = writer.book

            if not rows_ok:
                ws = wb.add_worksheet('DATOS')
                ws.write(0, 0, 'No hay datos para exportar')
                output.seek(0)
                return output.getvalue()

            # ---------- HOJA DATOS ----------
            export_rows = []
            sin_clasif = set()
            for inv in rows_ok:
                if not inv.get('clasificacion') or inv.get('clasificacion') == "SIN CLASIFICAR":
                    sin_clasif.add((inv.get('ruc_proveedor', ''), inv.get('nombre_proveedor', '')))
                r = {}
                for header, key in DATOS_COLS:
                    if key == "es_excepcion":
                        r[header] = "⚡ EXCEPCIÓN" if inv.get("es_excepcion") else ""
                        continue
                    val = inv.get(key, "")
                    if key in NUMERIC_KEYS:
                        try:
                            r[header] = float(val)
                        except (TypeError, ValueError):
                            r[header] = 0.0
                    else:
                        r[header] = val if val is not None else ""
                export_rows.append(r)

            headers = [h for h, _ in DATOS_COLS]
            df = pd.DataFrame(export_rows)[headers]
            df.to_excel(writer, index=False, sheet_name='DATOS')

            ws = writer.sheets['DATOS']
            fmt_curr = wb.add_format({'num_format': '$#,##0.00'})
            for i, h in enumerate(headers):
                if any(x in h for x in ["Base", "IVA", "Total", "Exento", "Desc", "Objeto"]):
                    ws.set_column(i, i, 12, fmt_curr)
                elif h in ("Nombre", "Concepto", "Destinatario"):
                    ws.set_column(i, i, 28)
                else:
                    ws.set_column(i, i, 14)

            # ---------- HOJA RESUMEN ----------
            ws_res = wb.add_worksheet('RESUMEN')
            cats = sorted({(inv.get('clasificacion') or '').upper() for inv in rows_ok if inv.get('clasificacion')})
            l_pers = [c for c in cats if c in GASTOS_PERSONALES]
            l_ejer = [c for c in cats if c not in GASTOS_PERSONALES and c != "SIN CLASIFICAR"]

            def write_summary_table(start_row, title, cat_list, color_hex):
                fmt_head = wb.add_format({'bold': True, 'bg_color': color_hex, 'font_color': 'white', 'border': 1, 'align': 'center'})
                fmt_cell = wb.add_format({'border': 1})
                fmt_num = wb.add_format({'num_format': '$#,##0.00', 'border': 1})
                fmt_total_lbl = wb.add_format({'bold': True, 'bg_color': color_hex, 'font_color': 'white', 'border': 1, 'align': 'center'})
                fmt_total_int = wb.add_format({'num_format': '0', 'border': 1, 'bold': True})
                fmt_total_num = wb.add_format({'num_format': '$#,##0.00', 'border': 1, 'bold': True})

                # (encabezado, letra de la columna en DATOS). Las letras salen de
                # DATOS_COLS para que no se desfasen si se agregan columnas.
                letra = {key: chr(65 + i) for i, (_, key) in enumerate(DATOS_COLS)}
                cols = [("No Objeto IVA", "no_objeto_iva"), ("Exento IVA", "exento_iva"),
                        ("Base 0%", "base_0"), ("Base 5%", "base_5"), ("IVA 5%", "iva_5"),
                        ("Base 8%", "base_8"), ("IVA 8%", "iva_8"),
                        ("Base 15%", "base_15"), ("IVA 15%", "iva_15"), ("Total", "total")]
                heads = ["Concepto", "# Facturas"] + [h for h, _ in cols]
                ultima = len(heads) - 1
                ws_res.merge_range(start_row, 0, start_row, ultima, title, wb.add_format({'bold': True, 'font_size': 12}))
                for i, h in enumerate(heads):
                    ws_res.write(start_row + 1, i, h, fmt_head)

                curr = start_row + 2
                for c in cat_list:
                    crit = f'"{c}"'
                    ws_res.write(curr, 0, c, fmt_cell)
                    ws_res.write_formula(curr, 1, f'=COUNTIF(DATOS!F:F, {crit})', fmt_cell)
                    for j, (_, key) in enumerate(cols, start=2):
                        L = letra[key]
                        ws_res.write_formula(curr, j, f'=SUMIF(DATOS!F:F, {crit}, DATOS!{L}:{L})', fmt_num)
                    curr += 1

                ws_res.write(curr, 0, "TOTAL GENERAL", fmt_total_lbl)
                ws_res.write_formula(curr, 1, f'=SUM(B{start_row + 3}:B{curr})', fmt_total_int)
                for col_idx in range(2, ultima + 1):
                    col_char = chr(65 + col_idx)
                    ws_res.write_formula(curr, col_idx, f'=SUM({col_char}{start_row + 3}:{col_char}{curr})', fmt_total_num)
                return curr + 3

            row_cursor = 0
            row_cursor = write_summary_table(row_cursor, "GASTOS PERSONALES", l_pers, "#28a745")
            row_cursor = write_summary_table(row_cursor, "GASTOS DEL EJERCICIO", l_ejer, "#007bff")

            # Aviso de gastos con clasificación EXCEPCIONAL (modificada solo para
            # este contribuyente/período): deja constancia en el reporte de que la
            # clasificación de esos proveedores fue cambiada a propósito.
            excep_map = {}
            for inv in rows_ok:
                if inv.get("es_excepcion"):
                    key = (inv.get("ruc_proveedor", ""), inv.get("nombre_proveedor", ""))
                    excep_map[key] = (inv.get("clasificacion") or "").upper()
            if excep_map:
                fmt_ex_title = wb.add_format({'bold': True, 'font_size': 12, 'font_color': '#92400e'})
                ws_res.merge_range(row_cursor, 0, row_cursor, 9,
                                   "⚡ GASTOS CON CLASIFICACIÓN EXCEPCIONAL (modificada solo para este contribuyente y período)",
                                   fmt_ex_title)
                fmt_ex_head = wb.add_format({'bold': True, 'bg_color': '#f59e0b', 'font_color': 'white', 'border': 1})
                fmt_ex_cell = wb.add_format({'border': 1})
                hr = row_cursor + 1
                for i, h in enumerate(["RUC", "Proveedor", "Categoría excepcional aplicada"]):
                    ws_res.write(hr, i, h, fmt_ex_head)
                rr = hr + 1
                for (ruc, nom), cat in sorted(excep_map.items()):
                    ws_res.write(rr, 0, ruc, fmt_ex_cell)
                    ws_res.write(rr, 1, nom, fmt_ex_cell)
                    ws_res.write(rr, 2, cat, fmt_ex_cell)
                    rr += 1
                row_cursor = rr + 2

            ws_res.set_column(0, 0, 30)
            ws_res.set_column(1, 11, 15)

            # ---------- HOJA PENDIENTES ----------
            if sin_clasif:
                pd.DataFrame(sorted(sin_clasif), columns=["RUC", "Nombre"]).to_excel(
                    writer, sheet_name='PENDIENTES', index=False
                )

        output.seek(0)
        return output.getvalue()
    except Exception as e:
        print(f"Error in generate_excel: {e}")
        return b""


def generate_pdf(invoices: List[Dict], titulo: str = "Resumen de Gastos") -> bytes:
    """Genera PDF con detalle y resumen por clasificación."""
    rows_ok = [inv for inv in invoices if inv.get('estado') == 'OK']
    if not rows_ok:
        return b""

    try:
        output = io.BytesIO()
        doc = SimpleDocTemplate(output, pagesize=landscape(letter),
                                leftMargin=0.5 * inch, rightMargin=0.5 * inch)
        styles = getSampleStyleSheet()
        story = [Paragraph(titulo, styles['Title']), Spacer(1, 0.2 * inch)]

        def num(inv, key):
            try:
                return float(inv.get(key) or 0)
            except (TypeError, ValueError):
                return 0.0

        # Tarifas con valor: la 8% solo aparece si alguna factura la tiene.
        tarifas = [("Base 15%", "base_15"), ("IVA 15%", "iva_15")]
        if any(num(i, "base_8") or num(i, "iva_8") for i in rows_ok):
            tarifas += [("Base 8%", "base_8"), ("IVA 8%", "iva_8")]
        tarifas += [("Base 5%", "base_5"), ("IVA 5%", "iva_5")]
        claves = [k for _, k in tarifas] + ["total"]

        # Resumen por clasificación
        resumen = {}
        for inv in rows_ok:
            cat = (inv.get('clasificacion') or 'SIN CLASIFICAR')
            s = resumen.setdefault(cat, {"n": 0, **{k: 0.0 for k in claves}})
            s["n"] += 1
            for k in claves:
                s[k] += num(inv, k)

        res_data = [["Clasificación", "# Facturas"] + [h for h, _ in tarifas] + ["Total"]]
        for cat in sorted(resumen):
            s = resumen[cat]
            res_data.append([cat, str(s["n"])] + [f"${s[k]:,.2f}" for k in claves])
        res_data.append(["TOTAL", str(len(rows_ok))]
                        + [f"${sum(s[k] for s in resumen.values()):,.2f}" for k in claves])

        ancho_num = 6.6 * inch / len(claves)
        res_table = Table(res_data, colWidths=[2.4 * inch, 0.9 * inch] + [ancho_num] * len(claves))
        res_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1f2937')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
            ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#e5e7eb')),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
        ]))
        story.append(Paragraph("Resumen por Clasificación", styles['Heading2']))
        story.append(res_table)
        story.append(Spacer(1, 0.3 * inch))

        # Gastos con clasificación EXCEPCIONAL (modificada solo para este
        # contribuyente/período): se listan para dejar constancia en el reporte.
        excep_map = {}
        for inv in rows_ok:
            if inv.get('es_excepcion'):
                excep_map[(inv.get('ruc_proveedor', ''), str(inv.get('nombre_proveedor', '')))] = (inv.get('clasificacion') or '').upper()
        if excep_map:
            ex_data = [["RUC", "Proveedor", "Categoría excepcional aplicada"]]
            for (ruc, nom), cat in sorted(excep_map.items()):
                ex_data.append([ruc, nom[:30], cat])
            ex_table = Table(ex_data, colWidths=[1.4 * inch, 3.0 * inch, 2.2 * inch])
            ex_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#f59e0b')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 8),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
                ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#fff7ed')),
            ]))
            story.append(Paragraph("⚡ Clasificación excepcional (modificada solo para este contribuyente y período)", styles['Heading2']))
            story.append(ex_table)
            story.append(Spacer(1, 0.3 * inch))

        # Detalle (marca ⚡ en la clasificación de los gastos con excepción)
        data = [["Fecha", "RUC", "Proveedor", "Clasificación"] + [h for h, _ in tarifas] + ["Total"]]
        for inv in rows_ok[:200]:
            clasif = inv.get('clasificacion', '') or ''
            if inv.get('es_excepcion'):
                clasif = f"⚡ {clasif}"
            data.append([
                inv.get('fecha', ''),
                inv.get('ruc_proveedor', ''),
                str(inv.get('nombre_proveedor', ''))[:24],
                clasif[:18],
            ] + [f"${num(inv, k):,.2f}" for k in claves])

        ancho_det = 5.2 * inch / len(claves)
        table = Table(data, colWidths=[0.75 * inch, 1.0 * inch, 1.9 * inch, 1.15 * inch] + [ancho_det] * len(claves))
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1f2937')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('ALIGN', (4, 0), (-1, -1), 'RIGHT'),
        ]))
        story.append(Paragraph("Detalle de Facturas", styles['Heading2']))
        story.append(table)

        doc.build(story)
        output.seek(0)
        return output.getvalue()
    except Exception as e:
        print(f"Error in generate_pdf: {e}")
        return b""
