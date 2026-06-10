from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from auth import get_current_user
from database import get_supabase_client
from services.compradores import sync_desde_ventas

router = APIRouter(prefix="/api/compradores", tags=["compradores"])

COLUMNS = "id,identificacion,ruc,tipo_id,nombre,created_at"


@router.get("/")
async def listar(identificacion: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    """Clientes importados del usuario, opcionalmente de un solo contribuyente."""
    try:
        supabase = get_supabase_client()
        q = supabase.table("compradores").select(COLUMNS).eq("user_id", user_id)
        if identificacion:
            q = q.eq("identificacion", identificacion)
        return {"data": q.order("nombre").execute().data or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sync")
async def sincronizar(user_id: str = Depends(get_current_user)):
    """Reconstruye los clientes importados desde las ventas ICE ya guardadas."""
    try:
        supabase = get_supabase_client()
        total = sync_desde_ventas(supabase, user_id)
        return {"message": "Clientes sincronizados", "total": total}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{comprador_id}")
async def eliminar(comprador_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("compradores").delete().eq("id", comprador_id).eq("user_id", user_id).execute()
        return {"message": "Eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
