import csv
import io
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.min_produccion import verificar_ruc

router = APIRouter(prefix="/api/rebajas", tags=["rebajas"])


@router.get("/verificar-ruc")
async def verificar(ruc: str = Query(...), _: str = Depends(get_current_user)):
    """Verifica en el Ministerio de Producción si el RUC está categorizado."""
    return verificar_ruc(ruc)

COLUMNS = "id,identificacion,producto,ingrediente,ruc_proveedor,proveedor_nombre,cantidad,unidad,densidad,origen,calificado"


class RebajaIn(BaseModel):
    identificacion: str
    producto: str
    ingrediente: str
    ruc_proveedor: Optional[str] = ""
    proveedor_nombre: Optional[str] = ""
    cantidad: float = 0
    unidad: Optional[str] = "ml"
    densidad: Optional[float] = 1
    origen: Optional[str] = "NACIONAL"
    calificado: Optional[bool] = False


@router.get("/")
async def list_rebajas(
    identificacion: str = Query(...),
    producto: Optional[str] = Query(None),
    user_id: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        q = supabase.table("rebajas_ingredientes").select(COLUMNS).eq("identificacion", identificacion).eq("user_id", user_id)
        if producto:
            q = q.eq("producto", producto)
        return {"data": q.order("ingrediente").execute().data or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def create_rebaja(entry: RebajaIn, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        data = entry.dict()
        data["user_id"] = user_id
        data["ingrediente"] = (data.get("ingrediente") or "").strip().upper()
        data["origen"] = (data.get("origen") or "NACIONAL").upper()
        if not data["ingrediente"]:
            raise HTTPException(status_code=400, detail="El ingrediente es obligatorio")
        res = supabase.table("rebajas_ingredientes").insert(data).execute()
        return res.data[0] if res.data else None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{rid}")
async def delete_rebaja(rid: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("rebajas_ingredientes").delete().eq("id", rid).eq("user_id", user_id).execute()
        return {"message": "Eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Carga masiva de componentes (pegar de Excel / subir archivo) ──

class RebajaBulkItem(BaseModel):
    ingrediente: str
    ruc_proveedor: Optional[str] = ""
    proveedor_nombre: Optional[str] = ""
    cantidad: float = 0
    unidad: Optional[str] = "ml"
    densidad: Optional[float] = 1
    origen: Optional[str] = "NACIONAL"
    calificado: Optional[bool] = False


class RebajaBulkIn(BaseModel):
    identificacion: str
    producto: str
    items: List[RebajaBulkItem]


def _f(v, d=0.0):
    try:
        return float(str(v).replace(",", ".").strip())
    except (TypeError, ValueError):
        return d


def _insertar_componentes(supabase, user_id, identificacion, producto, items):
    """Inserta una lista de componentes; autocompleta calificado/nombre desde el
    catálogo de proveedores si el RUC ya está guardado. Devuelve cuántos insertó."""
    producto = (producto or "").strip().upper()
    # Catálogo de proveedores del contribuyente (RUC → nombre/calificado)
    cat = {}
    try:
        pv = supabase.table("rebajas_proveedores").select("ruc,nombre,calificado")\
            .eq("user_id", user_id).eq("identificacion", identificacion).execute().data or []
        cat = {p["ruc"]: p for p in pv}
    except Exception:
        cat = {}
    filas = []
    for it in items:
        ing = (it.get("ingrediente") if isinstance(it, dict) else it.ingrediente) or ""
        ing = ing.strip().upper()
        if not ing:
            continue
        d = it if isinstance(it, dict) else it.dict()
        ruc = (d.get("ruc_proveedor") or "").strip()
        prov = cat.get(ruc)
        filas.append({
            "user_id": user_id, "identificacion": identificacion, "producto": producto,
            "ingrediente": ing, "ruc_proveedor": ruc,
            "proveedor_nombre": (d.get("proveedor_nombre") or (prov or {}).get("nombre") or "").strip().upper(),
            "cantidad": _f(d.get("cantidad")), "unidad": (d.get("unidad") or "ml").strip(),
            "densidad": _f(d.get("densidad"), 1) or 1,
            "origen": (d.get("origen") or "NACIONAL").upper(),
            "calificado": bool(d.get("calificado")) or bool((prov or {}).get("calificado")),
        })
    if not filas:
        return 0
    supabase.table("rebajas_ingredientes").insert(filas).execute()
    return len(filas)


@router.post("/bulk")
async def bulk_create(entry: RebajaBulkIn, user_id: str = Depends(get_current_user)):
    """Carga masiva de componentes pegados desde Excel (filas ya parseadas)."""
    try:
        supabase = get_supabase_client()
        n = _insertar_componentes(supabase, user_id, entry.identificacion, entry.producto, entry.items)
        return {"insertados": n}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


_COL_ALIASES = {
    "ruc_proveedor": ("ruc", "ruc proveedor", "ruc_proveedor", "ruc del proveedor"),
    "proveedor_nombre": ("proveedor", "empresa", "nombre", "razon social", "razón social", "proveedor_nombre"),
    "ingrediente": ("ingrediente", "componente", "producto", "materia prima", "insumo"),
    "cantidad": ("cantidad", "cant", "qty", "volumen", "peso"),
    "unidad": ("unidad", "und", "um", "u.m."),
    "densidad": ("densidad", "dens", "densidad g/ml"),
}


def _norm(s):
    return str(s or "").strip().lower()


def _mapear_encabezados(header):
    idx = {}
    for j, h in enumerate(header):
        hn = _norm(h)
        for campo, alias in _COL_ALIASES.items():
            if campo not in idx and hn in alias:
                idx[campo] = j
    return idx


def _filas_a_items(rows):
    """rows: lista de listas (primera fila = encabezados). Devuelve items dict."""
    if not rows:
        return []
    idx = _mapear_encabezados(rows[0])
    if "ingrediente" not in idx:
        raise HTTPException(status_code=400, detail="No se encontró la columna de ingrediente/componente. Encabezados esperados: RUC, Proveedor, Ingrediente, Cantidad, Unidad, Densidad.")
    items = []
    for r in rows[1:]:
        def g(c):
            j = idx.get(c)
            return r[j] if (j is not None and j < len(r)) else ""
        if not _norm(g("ingrediente")):
            continue
        items.append({
            "ruc_proveedor": str(g("ruc_proveedor") or "").strip(),
            "proveedor_nombre": str(g("proveedor_nombre") or "").strip(),
            "ingrediente": str(g("ingrediente") or "").strip(),
            "cantidad": g("cantidad"), "unidad": str(g("unidad") or "ml").strip() or "ml",
            "densidad": g("densidad"),
        })
    return items


@router.post("/parse-file")
async def parse_file(
    file: UploadFile = File(...),
    identificacion: str = Form(...),
    producto: str = Form(...),
    user_id: str = Depends(get_current_user),
):
    """Sube un .xlsx/.csv de componentes, lo parsea e inserta. Devuelve cuántos."""
    try:
        content = await file.read()
        name = (file.filename or "").lower()
        rows = []
        if name.endswith(".csv") or name.endswith(".txt"):
            text = content.decode("utf-8-sig", errors="replace")
            sep = "\t" if "\t" in text.splitlines()[0] else ","
            rows = [r for r in csv.reader(io.StringIO(text), delimiter=sep)]
        else:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True, read_only=True)
            sh = wb.active
            for r in sh.iter_rows(values_only=True):
                rows.append(list(r))
        items = _filas_a_items(rows)
        supabase = get_supabase_client()
        n = _insertar_componentes(supabase, user_id, identificacion, producto, items)
        return {"insertados": n}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"No se pudo leer el archivo: {e}")


# ── Catálogo reutilizable de proveedores (RUC → nombre + calificado) ──

PROV_COLS = "id,identificacion,ruc,nombre,calificado,categoria,vigencia,verificado_at"


class ProveedorIn(BaseModel):
    identificacion: str
    ruc: str
    nombre: Optional[str] = ""
    calificado: Optional[bool] = False
    categoria: Optional[str] = ""
    vigencia: Optional[str] = ""


@router.get("/proveedores")
async def list_proveedores(identificacion: str = Query(...), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        r = supabase.table("rebajas_proveedores").select(PROV_COLS)\
            .eq("identificacion", identificacion).eq("user_id", user_id).order("nombre").execute()
        return {"data": r.data or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _upsert_proveedor(supabase, user_id, ident, ruc, nombre, calificado, categoria="", vigencia=""):
    data = {
        "user_id": user_id, "identificacion": ident, "ruc": (ruc or "").strip(),
        "nombre": (nombre or "").strip().upper(), "calificado": bool(calificado),
        "categoria": categoria or "", "vigencia": vigencia or "",
        "verificado_at": datetime.now(timezone.utc).isoformat(),
    }
    return supabase.table("rebajas_proveedores").upsert(
        data, on_conflict="user_id,identificacion,ruc").execute()


@router.put("/proveedores")
async def upsert_proveedor(entry: ProveedorIn, user_id: str = Depends(get_current_user)):
    """Guarda/actualiza un proveedor en el catálogo (tras verificar el RUC)."""
    try:
        if not (entry.ruc or "").strip():
            raise HTTPException(status_code=400, detail="El RUC es obligatorio")
        supabase = get_supabase_client()
        res = _upsert_proveedor(supabase, user_id, entry.identificacion, entry.ruc,
                                entry.nombre, entry.calificado, entry.categoria, entry.vigencia)
        return res.data[0] if res.data else None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/proveedores/verificar-todos")
async def verificar_todos(
    identificacion: str = Query(...),
    producto: Optional[str] = Query(None),
    user_id: str = Depends(get_current_user),
):
    """Verifica en el Ministerio todos los RUC distintos (de un producto o del RUC
    completo), actualiza el catálogo de proveedores y los componentes guardados."""
    try:
        supabase = get_supabase_client()
        q = supabase.table("rebajas_ingredientes").select("ruc_proveedor")\
            .eq("identificacion", identificacion).eq("user_id", user_id)
        if producto:
            q = q.eq("producto", producto.strip().upper())
        rucs = sorted({(r.get("ruc_proveedor") or "").strip() for r in (q.execute().data or [])} - {""})
        resultados = []
        for ruc in rucs:
            try:
                d = verificar_ruc(ruc)
            except Exception as e:
                resultados.append({"ruc": ruc, "error": str(e)})
                continue
            cumple = bool(d.get("cumple"))
            nombre = d.get("razon_social") or ""
            _upsert_proveedor(supabase, user_id, identificacion, ruc, nombre, cumple,
                              d.get("categoria", ""), d.get("vigencia", ""))
            # Propaga a los componentes guardados con ese RUC
            upd = supabase.table("rebajas_ingredientes").update(
                {"calificado": cumple, "proveedor_nombre": (nombre or "").upper()})\
                .eq("identificacion", identificacion).eq("user_id", user_id).eq("ruc_proveedor", ruc)
            if producto:
                upd = upd.eq("producto", producto.strip().upper())
            upd.execute()
            resultados.append({"ruc": ruc, "cumple": cumple, "nombre": nombre,
                               "categoria": d.get("categoria", ""), "mensaje": d.get("mensaje", "")})
        return {"verificados": len(resultados), "data": resultados}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Condiciones normativas por producto (Art. 82/77 LRTI, Art. 199.4/199.5 RLRTI) ──

PROD_COLS = "id,identificacion,producto,es_cerveza,nueva_marca,cupo_anual_sri"


class CondicionesProducto(BaseModel):
    identificacion: str
    producto: str
    es_cerveza: bool = False        # cerveza: rebaja/exención solo para nuevas marcas
    nueva_marca: bool = False       # sin marca primigenia + nueva notificación sanitaria
    cupo_anual_sri: bool = False    # cupo anual del SRI (requisito de la exención)


@router.get("/producto")
async def get_condiciones(
    identificacion: str = Query(...),
    producto: Optional[str] = Query(None),
    user_id: str = Depends(get_current_user),
):
    """Condiciones normativas guardadas (de un producto, o todas las del RUC)."""
    try:
        supabase = get_supabase_client()
        q = supabase.table("rebajas_productos").select(PROD_COLS).eq(
            "identificacion", identificacion).eq("user_id", user_id)
        if producto:
            q = q.eq("producto", producto.strip().upper())
        return {"data": q.execute().data or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/producto")
async def set_condiciones(entry: CondicionesProducto, user_id: str = Depends(get_current_user)):
    """Crea o actualiza las condiciones normativas del producto (upsert)."""
    try:
        supabase = get_supabase_client()
        data = entry.dict()
        data["producto"] = (data.get("producto") or "").strip().upper()
        if not data["producto"]:
            raise HTTPException(status_code=400, detail="El producto es obligatorio")
        data["user_id"] = user_id
        res = supabase.table("rebajas_productos").upsert(
            data, on_conflict="user_id,identificacion,producto").execute()
        return res.data[0] if res.data else None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
