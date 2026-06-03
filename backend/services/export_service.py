import pandas as pd
from typing import List, Dict
import io
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
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
        # Retornar Excel vacío
        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
            pass
        return output.getvalue()

    rows_exp = []

    for invoice in invoices:
        if invoice.get('estado') == 'OK':
            rows_exp.append(invoice)

    output = io.BytesIO()

    try:
        with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
            wb = writer.book

            if rows_exp:
                df = pd.DataFrame(rows_exp)
                cols = ['fecha', 'ruc_proveedor', 'nombre_proveedor', 'clasificacion', 'concepto',
                        'base_0', 'base_15', 'iva_15', 'base_5', 'iva_5', 'exento_iva', 'total']

                available_cols = [c for c in cols if c in df.columns]
                df_export = df[available_cols].copy()

                df_export.to_excel(writer, index=False, sheet_name='DATOS')

                ws = writer.sheets['DATOS']
                fmt_curr = wb.add_format({'num_format': '$#,##0.00'})

                for i, c in enumerate(available_cols):
                    if any(x in c for x in ["base", "iva", "total", "exento"]):
                        ws.set_column(i, i, 12, fmt_curr)
                    else:
                        ws.set_column(i, i, 20)
            else:
                ws = wb.add_worksheet('DATOS')
                ws.write(0, 0, 'No hay datos para exportar')

            # Hoja de resumen
            ws_res = wb.add_worksheet('RESUMEN')
            ws_res.write(0, 0, 'Resumen de Facturas')
            ws_res.write(1, 0, f'Total de facturas: {len(rows_exp)}')

            if rows_exp:
                total_sum = sum(float(r.get('total', 0)) for r in rows_exp)
                ws_res.write(2, 0, f'Monto total: ${total_sum:,.2f}')

        output.seek(0)
        return output.getvalue()
    except Exception as e:
        print(f"Error in generate_excel: {e}")
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

        story.append(Paragraph(titulo, styles['Title']))
        story.append(Spacer(1, 0.3 * inch))

        # Datos para la tabla
        data = [["Fecha", "Proveedor", "Concepto", "Clasificación", "Total"]]

        for inv in invoices[:100]:
            if inv.get('estado') == 'OK':
                data.append([
                    inv.get('fecha', ''),
                    str(inv.get('nombre_proveedor', ''))[:25],
                    str(inv.get('concepto', ''))[:20],
                    inv.get('clasificacion', ''),
                    f"${float(inv.get('total', 0)):,.2f}"
                ])

        if len(data) > 1:
            table = Table(data, colWidths=[1.0*inch, 1.8*inch, 1.5*inch, 1.5*inch, 1.2*inch])
            table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1f2937')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, 0), 9),
                ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
                ('GRID', (0, 0), (-1, -1), 1, colors.grey)
            ]))
            story.append(table)
        else:
            story.append(Paragraph("No hay facturas para mostrar", styles['Normal']))

        doc.build(story)
        output.seek(0)
        return output.getvalue()
    except Exception as e:
        print(f"Error in generate_pdf: {e}")
        return b""
