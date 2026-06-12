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
