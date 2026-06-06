from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client

router = APIRouter(prefix="/api/rebajas", tags=["rebajas"])

COLUMNS = "id,identificacion,producto,ingrediente,ruc_proveedor,cantidad,unidad,origen,calificado"


class RebajaIn(BaseModel):
    identificacion: str
    producto: str
    ingrediente: str
    ruc_proveedor: Optional[str] = ""
    cantidad: float = 0
    unidad: Optional[str] = "ml"
    origen: Optional[str] = "NACIONAL"
    calificado: Optional[bool] = False


@router.get("/")
async def list_rebajas(
    identificacion: str = Query(...),
    producto: Optional[str] = Query(None),
    _: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        q = supabase.table("rebajas_ingredientes").select(COLUMNS).eq("identificacion", identificacion)
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
async def delete_rebaja(rid: str, _: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("rebajas_ingredientes").delete().eq("id", rid).execute()
        return {"message": "Eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
