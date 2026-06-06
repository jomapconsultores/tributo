"""Búsqueda en el catálogo oficial de Códigos ICE del SRI (resources/codigos_ice.xls).
Cada hoja con nombre numérico (3011, 3031, …) es un impuesto; sus filas tienen:
Código Impuesto | Impuesto | Código Clasificación | Clasificación | Código de Marca | Descripción.
Las hojas de listas (Presentacion, Capacidad, Unidad, Grado_Alcoholico, País) son catálogos auxiliares."""
import os

_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "codigos_ice.xls")
_marcas_cache = None
_lookups_cache = None


def _i(v):
    try:
        return str(int(float(v)))
    except (TypeError, ValueError):
        return str(v or "").strip()


def _cargar_marcas():
    global _marcas_cache
    if _marcas_cache is not None:
        return _marcas_cache
    out = []
    try:
        import xlrd
        wb = xlrd.open_workbook(_PATH)
        for sh in wb.sheets():
            if not sh.name.strip().isdigit():
                continue  # solo hojas de impuesto
            for r in range(4, sh.nrows):
                desc = str(sh.cell_value(r, 5) or "").strip()
                if not desc:
                    continue
                out.append({
                    "impuesto": _i(sh.cell_value(r, 0)),
                    "impuesto_nombre": str(sh.cell_value(r, 1) or "").strip(),
                    "clasif_cod": _i(sh.cell_value(r, 2)),
                    "clasificacion": str(sh.cell_value(r, 3) or "").strip(),
                    "marca": _i(sh.cell_value(r, 4)),
                    "descripcion": desc,
                })
    except Exception as e:
        print(f"Error cargando codigos ICE: {e}")
    _marcas_cache = out
    return out


def buscar(q, impuesto=None, limit=40):
    data = _cargar_marcas()
    q = (q or "").strip().upper()
    res = []
    for d in data:
        if impuesto and d["impuesto"] != str(impuesto):
            continue
        if q and (q not in d["descripcion"].upper()
                  and q not in d["clasificacion"].upper()
                  and q not in d["marca"]):
            continue
        res.append(d)
        if len(res) >= limit:
            break
    return res


def lookups():
    global _lookups_cache
    if _lookups_cache is not None:
        return _lookups_cache
    out = {"presentacion": [], "capacidad": [], "unidad": [], "grado": [], "pais": []}
    sheets = {"Presentacion": "presentacion", "Capacidad": "capacidad", "Unidad": "unidad",
              "Grado_Alcoholico": "grado", "País": "pais"}
    try:
        import xlrd
        wb = xlrd.open_workbook(_PATH)
        for sname, key in sheets.items():
            try:
                sh = wb.sheet_by_name(sname)
            except Exception:
                continue
            # País tiene varios pares (código, descripción) por fila
            cols = 2
            cod_col, desc_col = (1, 2) if sname == "Presentacion" else (0, 1)
            for r in range(4, sh.nrows):
                if sname == "País":
                    for base in (0, 3, 6, 9):
                        if base + 1 >= sh.ncols:
                            continue
                        cod = _i(sh.cell_value(r, base))
                        desc = str(sh.cell_value(r, base + 1) or "").strip()
                        if cod and desc and cod != "0":
                            out[key].append({"codigo": cod, "descripcion": desc})
                else:
                    cod = _i(sh.cell_value(r, cod_col))
                    desc = str(sh.cell_value(r, desc_col) or "").strip()
                    if cod and desc:
                        out[key].append({"codigo": cod, "descripcion": desc})
    except Exception as e:
        print(f"Error cargando lookups ICE: {e}")
    _lookups_cache = out
    return out
