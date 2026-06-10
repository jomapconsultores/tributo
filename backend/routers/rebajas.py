from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.min_produccion import verificar_ruc

router = APIRouter(prefix="/api/rebajas", tags=["rebajas"])


@router.get("/verificar-ruc")
async def verificar(ruc: str = Query(...), _: str = Depends(get_current_user)):
    """Verifica en el Ministerio de Producción si el RUC está categorizado."""
    return verificar_ruc(ruc)

COLUMNS = "id,identificacion,producto,ingrediente,ruc_proveedor,proveedor_nombre,cantidad,unidad,origen,calificado"


class RebajaIn(BaseModel):
    identificacion: str
    producto: str
    ingrediente: str
    ruc_proveedor: Optional[str] = ""
    proveedor_nombre: Optional[str] = ""
    cantidad: float = 0
    unidad: Optional[str] = "ml"
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
