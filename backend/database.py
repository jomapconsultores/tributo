# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
from supabase import create_client, Client
from config import get_settings
from functools import lru_cache

settings = get_settings()

@lru_cache()
def get_supabase_client() -> Client:
    return create_client(settings.supabase_url, settings.supabase_service_key)

def get_supabase_client_anon() -> Client:
    return create_client(settings.supabase_url, settings.supabase_anon_key)


import time as _time

# Errores de CONEXIÓN (no de datos) al hablar con Supabase. El proxy que tiene
# delante multiplexa las peticiones sobre una sola conexión HTTP/2 y, cuando se
# le acumulan muchas cabeceras grandes —una lista larga de client_id en la query
# string las hace enormes—, corta con GOAWAY / PROTOCOL_ERROR. Se manifestaba
# como 500 intermitentes: "ConnectionTerminated error_code:1" o, si la petición
# alcanzaba a salir, un HTML de 400 de Cloudflare que supabase-py no puede
# parsear ("JSON could not be generated"). Reintentar basta: httpx abre una
# conexión nueva y la siguiente pasa.
_ERRORES_CONEXION = ("connectionterminated", "remoteprotocolerror", "protocol_error",
                     "server disconnected", "connection reset", "json could not be generated")


def _es_error_de_conexion(e: Exception) -> bool:
    m = (str(e) or "").lower()
    return any(s in m for s in _ERRORES_CONEXION)


def _ejecutar_con_reintento(consulta, intentos: int = 3):
    """Ejecuta una consulta de LECTURA reintentando los cortes de conexión.

    Solo se usa desde fetch_all/fetch_in, que son de solo lectura: reintentar es
    seguro porque un GET repetido no cambia nada. Un error de datos (columna
    inexistente, permisos) NO se reintenta: se propaga tal cual."""
    for intento in range(intentos):
        try:
            return consulta().execute()
        except Exception as e:
            if intento == intentos - 1 or not _es_error_de_conexion(e):
                raise
            _time.sleep(0.15 * (intento + 1))


def fetch_all(query_factory, chunk: int = 1000):
    """Trae TODAS las filas de una consulta en bloques (paginación), para que
    los conteos y sumas no se trunquen cuando hay más de ~1000 registros.

    `query_factory` es una función que devuelve una consulta NUEVA cada vez,
    p.ej.:  fetch_all(lambda: sb.table('invoices').select('total').eq('user_id', uid))
    """
    filas = []
    inicio = 0
    while True:
        res = _ejecutar_con_reintento(
            lambda: query_factory().range(inicio, inicio + chunk - 1))
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


def es_error_duplicado(e: Exception) -> bool:
    """True si la excepción de un insert es por violar una constraint UNIQUE.
    Usa el código SQLSTATE real (23505 = unique_violation) cuando está
    disponible (postgrest.exceptions.APIError lo expone en `.code`), en vez de
    buscar 'duplicate'/'unique' como substring del mensaje — antes usado en
    invoices.py/ice.py/retentions.py, frágil ante cualquier mensaje de error
    que por casualidad contenga esas palabras sin ser realmente una duplicada."""
    if getattr(e, "code", None) == "23505":
        return True
    msg = str(e).lower()
    return "duplicate" in msg or "unique" in msg
