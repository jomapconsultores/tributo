"""Búsqueda en el catálogo oficial de Códigos ICE del SRI (resources/codigos_ice.xls).
Cada hoja con nombre numérico (3011, 3031, …) es un impuesto; sus filas tienen:
Código Impuesto | Impuesto | Código Clasificación | Clasificación | Código de Marca | Descripción.
Las hojas de listas (Presentacion, Capacidad, Unidad, Grado_Alcoholico, País) son catálogos auxiliares."""
import os
from services.storage import descargar_codigos

_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "codigos_ice.xls")
_marcas_cache = None
_lookups_cache = None


def _abrir_wb():
    """Abre el workbook de Códigos ICE desde Supabase Storage (o archivo local)."""
    import xlrd
    data = descargar_codigos()
    if data:
        return xlrd.open_workbook(file_contents=data)
    return xlrd.open_workbook(_PATH)


def limpiar_cache():
    """Invalida las cachés tras reemplazar el archivo de Códigos ICE."""
    global _marcas_cache, _lookups_cache
    _marcas_cache = None
    _lookups_cache = None


def _i(v):
    try:
        return str(int(float(v)))
    except (TypeError, ValueError):
        return str(v or "").strip()


def _cargar_marcas(force=False):
    global _marcas_cache
    if _marcas_cache is not None and not force:
        return _marcas_cache
    out = []
    try:
        wb = _abrir_wb()
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
    """Búsqueda en memoria (archivo). Fallback cuando la BD está vacía."""
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


def _sanitizar(q):
    return "".join(c for c in (q or "") if c.isalnum() or c.isspace() or c in "ÁÉÍÓÚÑáéíóúñ").strip()


def buscar_tokens(q, limit=20):
    """Marcas cuya descripción contiene TODAS las palabras de q (en cualquier
    orden). Búsqueda en memoria sobre el archivo."""
    tokens = [t for t in (q or "").upper().split() if t]
    if not tokens:
        return []
    res = []
    for d in _cargar_marcas():
        desc = d["descripcion"].upper()
        if all(t in desc for t in tokens):
            res.append(d)
            if len(res) >= limit:
                break
    return res


def buscar_tokens_bd(supabase, q, limit=20):
    """Como buscar_tokens pero contra la tabla ice_codigos (filtros AND).
    Si la tabla está vacía, cae al archivo."""
    if contar_bd(supabase) == 0:
        return buscar_tokens(q, limit)
    tokens = [_sanitizar(t) for t in (q or "").upper().split()]
    tokens = [t for t in tokens if t]
    if not tokens:
        return []
    query = supabase.table("ice_codigos").select(
        "impuesto,impuesto_nombre,clasif_cod,clasificacion,marca,descripcion")
    for t in tokens:
        query = query.ilike("descripcion", f"%{t}%")
    return query.limit(limit).execute().data or []


def contar_bd(supabase):
    try:
        r = supabase.table("ice_codigos").select("id", count="exact").limit(1).execute()
        return r.count or 0
    except Exception:
        return 0


def buscar_bd(supabase, q, impuesto=None, limit=40):
    """Búsqueda en la tabla ice_codigos. Si está vacía, cae al archivo."""
    if contar_bd(supabase) == 0:
        return buscar(q, impuesto, limit)
    qq = _sanitizar(q)
    query = supabase.table("ice_codigos").select(
        "impuesto,impuesto_nombre,clasif_cod,clasificacion,marca,descripcion")
    if impuesto:
        query = query.eq("impuesto", str(impuesto))
    if qq:
        query = query.or_(f"descripcion.ilike.%{qq}%,clasificacion.ilike.%{qq}%,marca.ilike.%{qq}%")
    return query.limit(limit).execute().data or []


def importar_a_bd(supabase):
    """Importa TODO el archivo a la tabla ice_codigos (reemplazo total:
    borra lo existente e inserta lo del archivo). Devuelve cuántos códigos quedaron."""
    marcas = _cargar_marcas(force=True)
    # Borrar todo
    supabase.table("ice_codigos").delete().neq("id", 0).execute()
    # Insertar por lotes
    lote = []
    insertados = 0
    for m in marcas:
        lote.append({
            "impuesto": m["impuesto"], "impuesto_nombre": m["impuesto_nombre"],
            "clasif_cod": m["clasif_cod"], "clasificacion": m["clasificacion"],
            "marca": m["marca"], "descripcion": m["descripcion"],
        })
        if len(lote) >= 1000:
            supabase.table("ice_codigos").insert(lote).execute()
            insertados += len(lote)
            lote = []
    if lote:
        supabase.table("ice_codigos").insert(lote).execute()
        insertados += len(lote)
    return insertados


def lookups():
    global _lookups_cache
    if _lookups_cache is not None:
        return _lookups_cache
    out = {"presentacion": [], "capacidad": [], "unidad": [], "grado": [], "pais": []}
    sheets = {"Presentacion": "presentacion", "Capacidad": "capacidad", "Unidad": "unidad",
              "Grado_Alcoholico": "grado", "País": "pais"}
    try:
        import xlrd
        wb = _abrir_wb()
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
