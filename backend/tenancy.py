"""Utilidades de aislamiento multiusuario (Fase 1).

Cada usuario solo puede ver/editar sus propios clientes y datos. Como el backend
usa la service key de Supabase (que omite RLS), el aislamiento se aplica en la
capa de aplicación: se filtra por user_id y se verifica la propiedad del cliente.
"""
from fastapi import HTTPException
from database import get_supabase_client


def assert_client_owner(client_id, user_id):
    """Lanza 404 si el client_id no pertenece al usuario."""
    supabase = get_supabase_client()
    r = supabase.table("clients").select("id").eq("id", client_id).eq("user_id", user_id).execute()
    if not r.data:
        raise HTTPException(status_code=404, detail="Cliente no encontrado")
    return True
