"""Llena el formulario oficial del SRI (IVA / ICE) a partir de la declaración
calculada. Criterio: el valor se escribe en la celda contigua (a la derecha) de
cada código SRI. Se omiten los códigos de la sección RESULTADO (399, 499…) que
el propio formulario calcula con sus fórmulas. Es un borrador a verificar."""
import io
import os
import openpyxl

TEMPLATES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "templates")


def llenar_oficial(tipo, decl):
    fname = "ice_form.xlsx" if str(tipo).upper() == "ICE" else "iva_form.xlsx"
    path = os.path.join(TEMPLATES, fname)
    if not os.path.exists(path):
        raise FileNotFoundError("No está la plantilla oficial: " + fname)

    # código -> valor (solo entradas, no resultados/fórmulas)
    valores = {}
    for f in decl.get("filas", []):
        if f.get("seccion") == "RESULTADO":
            continue
        cod = str(f.get("codigo", "")).strip()
        if cod.isdigit():
            valores[cod] = f.get("valor", 0)

    wb = openpyxl.load_workbook(path)
    llenados, omitidos = [], []

    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                s = str(cell.value).strip()
                if s not in valores:
                    continue
                target = ws.cell(row=cell.row, column=cell.column + 1)
                tv = target.value
                if isinstance(tv, str) and tv.startswith("="):
                    omitidos.append(s)
                    continue
                try:
                    target.value = valores[s]   # MergedCell de solo lectura lanza excepción
                    llenados.append(s)
                except Exception:
                    omitidos.append(s)

    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out.getvalue(), sorted(set(llenados)), sorted(set(omitidos))
