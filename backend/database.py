from supabase import create_client, Client
from config import get_settings
from functools import lru_cache

settings = get_settings()

@lru_cache()
def get_supabase_client() -> Client:
    return create_client(settings.supabase_url, settings.supabase_service_key)

def get_supabase_client_anon() -> Client:
    return create_client(settings.supabase_url, settings.supabase_anon_key)


def fetch_all(query_factory, chunk: int = 1000):
    """Trae TODAS las filas de una consulta en bloques (paginación), para que
    los conteos y sumas no se trunquen cuando hay más de ~1000 registros.

    `query_factory` es una función que devuelve una consulta NUEVA cada vez,
    p.ej.:  fetch_all(lambda: sb.table('invoices').select('total').eq('user_id', uid))
    """
    filas = []
    inicio = 0
    while True:
        res = query_factory().range(inicio, inicio + chunk - 1).execute()
        bloque = res.data or []
        filas.extend(bloque)
        if len(bloque) < chunk:
            break
        inicio += chunk
    return filas


def fetch_in(query_factory, ids, col: str = "client_id", chunk: int = 150):
    """fetch_all con filtro IN troceado: evita URLs gigantes cuando hay muchos
    ids (p.ej. un socio/administrador que ve a muchos contribuyentes).

    `query_factory` devuelve la consulta BASE (select + filtros .eq), SIN el
    `.in_` ni `.range` (los agrega esta función)."""
    ids = list(ids or [])
    if not ids:
        return []
    filas = []
    for i in range(0, len(ids), chunk):
        trozo = ids[i:i + chunk]
        filas.extend(fetch_all(lambda t=trozo: query_factory().in_(col, t)))
    return filas
