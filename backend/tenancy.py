"""Utilidades de aislamiento multiusuario.

El backend usa la service key de Supabase (que omite RLS), por lo que el
aislamiento se aplica en la capa de aplicación: se filtra por user_id y se
verifica la propiedad del cliente. Los accesos otorgados por el administrador
(tabla client_access) también se respetan.
"""
from fastapi import HTTPException
from database import get_supabase_client


def assert_client_owner(client_id, user_id):
    """Lanza 404 si el client_id no pertenece al usuario ni le fue otorgado acceso."""
    supabase = get_supabase_client()
    r = supabase.table("clients").select("id").eq("id", client_id).eq("user_id", user_id).execute()
    if r.data:
        return True
    g = supabase.table("client_access").select("client_id").eq("client_id", client_id).eq("granted_to", user_id).execute()
    if g.data:
        return True
    raise HTTPException(status_code=404, detail="Cliente no encontrado")


def shared_client_ids(user_id: str) -> list:
    """IDs de clientes explícitamente otorgados a user_id por un administrador."""
    supabase = get_supabase_client()
    rows = supabase.table("client_access").select("client_id").eq("granted_to", user_id).execute().data or []
    return [r["client_id"] for r in rows]
