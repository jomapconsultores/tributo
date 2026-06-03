import pandas as pd
from typing import List, Dict
import io
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib import colors
from datetime import datetime

GASTOS_PERSONALES = {
    "ALIMENTACIÓN", "ALIMENTACION", "EDUCACIÓN", "EDUCACION",
    "SALUD", "VESTIMENTA", "VIVIENDA", "VARIOS", "TURISMO", "ARTE Y CULTURA"
}

def generate_excel(invoices: List[Dict]) -> bytes:
    """Genera Excel con datos de facturas y resumen"""
    if not invoices:
        return b""

    rows_exp = []
    sin_clasif = set()

    for invoice in invoices:
        if invoice['estado'] != 'OK':
            continue
        if not invoice.get('clasificacion') or invoice['clasificacion'] == "SIN CLASIFICAR":
            sin_clasif.add((invoice['ruc_proveedor'], invoice['nombre_proveedor']))

        rows_exp.append(invoice)

    if not rows_exp:
        return b""

    try:
        df = pd.DataFrame(rows_exp)
        output = io.BytesIO()

        with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
            wb = writer.book
            cols = list(df.columns)
            df[cols].to_excel(writer, index=False, sheet_name='DATOS')

            ws = writer.sheets['DATOS']
            fmt_curr = wb.add_format({'num_format': '$#,##0.00'})

            for i, c in enumerate(cols):
                if any(x in c for x in ["base_", "iva_", "total", "exento", "desc_", "objeto"]):
                    ws.set_column(i, i, 12, fmt_curr)

            # RESUMEN
            ws_res = wb.add_worksheet('RESUMEN')
            cats = sorted(list(set(df['clasificacion'].dropna())))
            l_pers = [c for c in cats if c in GASTOS_PERSONALES]
            l_ejer = [c for c in cats if c not in GASTOS_PERSONALES and c != "SIN CLASIFICAR"]

            def write_summary_table(start_row, title, cat_list, color_hex):
                fmt_head = wb.add_format({'bold': True, 'bg_color': color_hex, 'font_color': 'white', 'border': 1, 'align': 'center'})
                fmt_cell = wb.add_format({'border': 1})
                fmt_num = wb.add_format({'num_format': '$#,##0.00', 'border': 1})
                fmt_total_lbl = wb.add_format({'bold': True, 'bg_color': color_hex, 'font_color': 'white', 'border': 1, 'align': 'center'})
                fmt_total_int = wb.add_format({'num_format': '0', 'border': 1, 'bold': True})
                fmt_total_num = wb.add_format({'num_format': '$#,##0.00', 'border': 1, 'bold': True})

                headers = ["Concepto", "# Facturas", "No Objeto IVA", "Exento IVA", "Base 0%", "Base 5%", "IVA 5%", "Base 15%", "IVA 15%", "Total"]
                ws_res.merge_range(start_row, 0, start_row, 9, title, wb.add_format({'bold': True, 'font_size': 12}))
                for i, h in enumerate(headers):
                    ws_res.write(start_row + 1, i, h, fmt_head)

                curr = start_row + 2
                for c in cat_list:
                    crit = f'"{c}"'
                    ws_res.write(curr, 0, c, fmt_cell)
                    ws_res.write_formula(curr, 1, f'=COUNTIF(DATOS!C:C, {crit})', fmt_cell)
                    ws_res.write_formula(curr, 2, f'=SUMIF(DATOS!C:C, {crit}, DATOS!K:K)', fmt_num)
                    ws_res.write_formula(curr, 3, f'=SUMIF(DATOS!C:C, {crit}, DATOS!L:L)', fmt_num)
                    ws_res.write_formula(curr, 4, f'=SUMIF(DATOS!C:C, {crit}, DATOS!M:M)', fmt_num)
                    ws_res.write_formula(curr, 5, f'=SUMIF(DATOS!C:C, {crit}, DATOS!Q:Q)', fmt_num)
                    ws_res.write_formula(curr, 6, f'=SUMIF(DATOS!C:C, {crit}, DATOS!R:R)', fmt_num)
                    ws_res.write_formula(curr, 7, f'=SUMIF(DATOS!C:C, {crit}, DATOS!N:N)', fmt_num)
                    ws_res.write_formula(curr, 8, f'=SUMIF(DATOS!C:C, {crit}, DATOS!O:O)', fmt_num)
                    ws_res.write_formula(curr, 9, f'=SUMIF(DATOS!C:C, {crit}, DATOS!T:T)', fmt_num)
                    curr += 1

                ws_res.write(curr, 0, "TOTAL GENERAL", fmt_total_lbl)
                ws_res.write_formula(curr, 1, f'=SUM(B{start_row+3}:B{curr})', fmt_total_int)
                for col_idx in range(2, 10):
                    col_char = chr(65 + col_idx)
                    ws_res.write_formula(curr, col_idx, f'=SUM({col_char}{start_row+3}:{col_char}{curr})', fmt_total_num)
                return curr + 3

            row_cursor = 0
            row_cursor = write_summary_table(row_cursor, "GASTOS PERSONALES", l_pers, "#28a745")
            row_cursor = write_summary_table(row_cursor, "GASTOS DEL EJERCICIO", l_ejer, "#007bff")
            ws_res.set_column(0, 0, 30)
            ws_res.set_column(1, 9, 15)

            if sin_clasif:
                pd.DataFrame(list(sin_clasif), columns=["RUC", "Nombre"]).to_excel(writer, sheet_name='PENDIENTES', index=False)

        output.seek(0)
        return output.getvalue()
    except Exception as e:
        print(f"Error generating Excel: {e}")
        return b""

def generate_pdf(invoices: List[Dict], titulo: str = "Resumen de Facturas") -> bytes:
    """Genera PDF con resumen de facturas"""
    if not invoices:
        return b""

    try:
        output = io.BytesIO()
        doc = SimpleDocTemplate(output, pagesize=letter)
        story = []

        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Heading1'],
            fontSize=16,
            textColor=colors.HexColor('#1f2937'),
            spaceAfter=20,
            alignment=1
        )

        story.append(Paragraph(titulo, title_style))
        story.append(Spacer(1, 0.3 * inch))

        # Tabla de datos
        data = [["Fecha", "Proveedor", "Concepto", "Clasificación", "Total"]]
        for inv in invoices[:100]:  # Máx 100 filas
            data.append([
                inv.get('fecha', ''),
                inv.get('nombre_proveedor', '')[:20],
                inv.get('concepto', '')[:20],
                inv.get('clasificacion', ''),
                f"${inv.get('total', 0):,.2f}"
            ])

        table = Table(data, colWidths=[1.2*inch, 1.8*inch, 1.5*inch, 1.5*inch, 1*inch])
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1f2937')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 10),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
            ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
            ('GRID', (0, 0), (-1, -1), 1, colors.black)
        ]))
        story.append(table)

        doc.build(story)
        output.seek(0)
        return output.getvalue()
    except Exception as e:
        print(f"Error generating PDF: {e}")
        return b""
