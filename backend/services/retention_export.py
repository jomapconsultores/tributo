import io
from typing import List, Dict
import pandas as pd

# Orden de columnas de la hoja DETALLE (igual que Retenciones.py, sin la ruta XML
# local que no aplica en la versión web).
COLS = [
    ("Fecha", "fecha"),
    ("RUC Emisor", "ruc_emisor"),
    ("Agente Retención", "agente_retencion"),
    ("Nro. Comprobante", "nro_comprobante"),
    ("Periodo Fiscal", "periodo_fiscal"),
    ("Base Renta", "base_renta"),
    ("% Renta", "porc_renta"),
    ("Ret. Renta", "ret_renta"),
    ("Base IVA", "base_iva"),
    ("% IVA", "porc_iva"),
    ("Ret. IVA", "ret_iva"),
    ("Ret. ISD", "ret_isd"),
    ("Total Retenido", "total_retenido"),
]

NUM_KEYS = {"base_renta", "porc_renta", "ret_renta", "base_iva", "porc_iva",
            "ret_iva", "ret_isd", "total_retenido"}


def generate_retention_excel(rows: List[Dict]) -> bytes:
    """Genera el Excel de retenciones con fórmulas (DETALLE) y RESUMEN_POR_AGENTE."""
    rows_ok = [r for r in rows if r.get("estado") != "DUPLICADO"]
    output = io.BytesIO()

    try:
        headers = [h for h, _ in COLS]
        keys = [k for _, k in COLS]
        df = pd.DataFrame([{h: r.get(k, "") for (h, k) in COLS} for r in rows_ok], columns=headers)
        for h, k in COLS:
            if k in NUM_KEYS:
                df[h] = pd.to_numeric(df[h], errors="coerce").fillna(0)

        with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
            wb = writer.book
            ws = wb.add_worksheet("DETALLE")

            fmt_head = wb.add_format({'bold': True, 'bg_color': '#007bff', 'font_color': 'white', 'border': 1})
            fmt_curr = wb.add_format({'num_format': '$#,##0.00'})
            fmt_total = wb.add_format({'num_format': '$#,##0.00', 'bold': True, 'top': 1})

            for i, h in enumerate(headers):
                ws.write(0, i, h, fmt_head)

            if not rows_ok:
                ws.write(1, 0, "No hay retenciones para exportar")
                output.seek(0)
                return output.getvalue()

            i_base_renta = keys.index("base_renta")
            i_pct_renta = keys.index("porc_renta")
            i_ret_renta = keys.index("ret_renta")
            i_base_iva = keys.index("base_iva")
            i_pct_iva = keys.index("porc_iva")
            i_ret_iva = keys.index("ret_iva")
            i_ret_isd = keys.index("ret_isd")
            i_total = keys.index("total_retenido")

            for row_idx, data in df.iterrows():
                excel_row = row_idx + 1
                for col_idx, (h, k) in enumerate(COLS):
                    val = data[h]
                    if k == "ret_renta":
                        cb = chr(65 + i_base_renta) + str(excel_row + 1)
                        cp = chr(65 + i_pct_renta) + str(excel_row + 1)
                        ws.write_formula(excel_row, col_idx, f'={cb}*({cp}/100)', fmt_curr)
                    elif k == "ret_iva":
                        cb = chr(65 + i_base_iva) + str(excel_row + 1)
                        cp = chr(65 + i_pct_iva) + str(excel_row + 1)
                        ws.write_formula(excel_row, col_idx, f'={cb}*({cp}/100)', fmt_curr)
                    elif k == "total_retenido":
                        cr = chr(65 + i_ret_renta) + str(excel_row + 1)
                        ci = chr(65 + i_ret_iva) + str(excel_row + 1)
                        cd = chr(65 + i_ret_isd) + str(excel_row + 1)
                        ws.write_formula(excel_row, col_idx, f'={cr}+{ci}+{cd}', fmt_curr)
                    elif k in NUM_KEYS:
                        ws.write(excel_row, col_idx, val, fmt_curr)
                    else:
                        ws.write(excel_row, col_idx, val)

            last_row = len(df) + 1
            ws.write(last_row, 0, "TOTALES GENERALES", fmt_total)
            for c_idx in [i_base_renta, i_ret_renta, i_base_iva, i_ret_iva, i_ret_isd, i_total]:
                col_letter = chr(65 + c_idx)
                ws.write_formula(last_row, c_idx, f'=SUM({col_letter}2:{col_letter}{last_row})', fmt_total)

            ws.set_column(0, 0, 12)
            ws.set_column(2, 2, 35)
            ws.set_column(3, 3, 20)
            ws.set_column(i_base_renta, i_total, 12)

            # ---------- RESUMEN_POR_AGENTE ----------
            ws_res = wb.add_worksheet("RESUMEN_POR_AGENTE")
            heads = ["Agente de Retención", "Cant.", "Ret. Renta", "Ret. IVA", "Ret. ISD", "Total"]
            for i, h in enumerate(heads):
                ws_res.write(0, i, h, fmt_head)

            grp = df.groupby("Agente Retención")[["Ret. Renta", "Ret. IVA", "Ret. ISD", "Total Retenido"]].sum().reset_index()
            counts = df["Agente Retención"].value_counts().reset_index()
            counts.columns = ["Agente Retención", "Cant."]
            grp = pd.merge(grp, counts, on="Agente Retención")

            fmt_border = wb.add_format({'border': 1})
            r_idx = 1
            for _, r in grp.iterrows():
                ws_res.write(r_idx, 0, r["Agente Retención"], fmt_border)
                ws_res.write(r_idx, 1, int(r["Cant."]), fmt_border)
                ws_res.write(r_idx, 2, r["Ret. Renta"], fmt_curr)
                ws_res.write(r_idx, 3, r["Ret. IVA"], fmt_curr)
                ws_res.write(r_idx, 4, r["Ret. ISD"], fmt_curr)
                ws_res.write(r_idx, 5, r["Total Retenido"], fmt_curr)
                r_idx += 1

            ws_res.write(r_idx, 0, "TOTAL FINAL", fmt_total)
            ws_res.write_formula(r_idx, 2, f"=SUM(C2:C{r_idx})", fmt_total)
            ws_res.write_formula(r_idx, 3, f"=SUM(D2:D{r_idx})", fmt_total)
            ws_res.write_formula(r_idx, 4, f"=SUM(E2:E{r_idx})", fmt_total)
            ws_res.write_formula(r_idx, 5, f"=SUM(F2:F{r_idx})", fmt_total)
            ws_res.set_column(0, 0, 35)
            ws_res.set_column(2, 5, 15)

        output.seek(0)
        return output.getvalue()
    except Exception as e:
        print(f"Error in generate_retention_excel: {e}")
        return b""
