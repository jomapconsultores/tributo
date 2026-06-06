from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from tenancy import assert_client_owner

router = APIRouter(prefix="/api/anexos", tags=["anexos"])


class AnexoIn(BaseModel):
    client_id: str
    tipo: str
    datos: dict


@router.get("/")
async def listar(client_id: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        q = supabase.table("anexos").select("id,client_id,tipo,datos,created_at").eq("user_id", user_id)
        if client_id:
            assert_client_owner(client_id, user_id)
            q = q.eq("client_id", client_id)
        return {"data": q.order("created_at", desc=True).execute().data or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def guardar(entry: AnexoIn, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(entry.client_id, user_id)
        res = supabase.table("anexos").insert({
            "client_id": entry.client_id, "user_id": user_id,
            "tipo": entry.tipo.upper(), "datos": entry.datos,
        }).execute()
        return res.data[0] if res.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{anexo_id}")
async def eliminar(anexo_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("anexos").delete().eq("id", anexo_id).eq("user_id", user_id).execute()
        return {"message": "Eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
