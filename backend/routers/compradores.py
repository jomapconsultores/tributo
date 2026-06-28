from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from auth import get_current_user
from database import get_supabase_client, fetch_all, fetch_in
from services.compradores import sync_desde_ventas
from tenancy import visible_clients, can_access_identificacion

router = APIRouter(prefix="/api/compradores", tags=["compradores"])

COLUMNS = "id,identificacion,ruc,tipo_id,nombre,created_at"


@router.get("/")
async def listar(identificacion: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    """Compradores visibles según el ROL: se comparten por contribuyente (RUC),
    igual que el catálogo de productos; el admin ve todos. Así no se pierden los que
    importó otro usuario del mismo contribuyente."""
    try:
        from routers.access import rol_de
        supabase = get_supabase_client()
        if identificacion:
            if not can_access_identificacion(user_id, identificacion):
                return {"data": []}
            rows = supabase.table("compradores").select(COLUMNS)\
                .eq("identificacion", identificacion).order("nombre").execute().data or []
            return {"data": rows}
        if rol_de(user_id) == "admin":
            return {"data": fetch_all(lambda: supabase.table("compradores").select(COLUMNS).order("nombre"))}
        idents = sorted({c.get("identificacion") for c in visible_clients(user_id, "identificacion") if c.get("identificacion")})
        if not idents:
            return {"data": []}
        rows = fetch_in(lambda: supabase.table("compradores").select(COLUMNS), idents, "identificacion")
        rows.sort(key=lambda r: (r.get("nombre") or ""))
        return {"data": rows}
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
