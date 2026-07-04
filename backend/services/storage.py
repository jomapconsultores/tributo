"""Almacenamiento del archivo de Códigos ICE en Supabase Storage.

En producción el disco del contenedor es efímero, así que el archivo reemplazable se
guarda en un bucket de Supabase. Se mantiene respaldo al archivo local para dev.
"""
import os
from database import get_supabase_client

BUCKET = "recursos"
CODIGOS_KEY = "codigos_ice.xls"
_LOCAL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "codigos_ice.xls")


def asegurar_bucket():
    sb = get_supabase_client()
    try:
        buckets = sb.storage.list_buckets()
        nombres = {getattr(b, "name", None) or (b.get("name") if isinstance(b, dict) else None) for b in buckets}
        if BUCKET not in nombres:
            sb.storage.create_bucket(BUCKET, options={"public": False})
    except Exception as e:
        print(f"asegurar_bucket: {e}")


def subir_codigos(content: bytes):
    sb = get_supabase_client()
    asegurar_bucket()
    sb.storage.from_(BUCKET).upload(
        CODIGOS_KEY, content,
        {"content-type": "application/vnd.ms-excel", "upsert": "true"},
    )


def descargar_codigos():
    """Devuelve los bytes del archivo: primero de Storage, luego del archivo local."""
    try:
        return get_supabase_client().storage.from_(BUCKET).download(CODIGOS_KEY)
    except Exception:
        pass
    if os.path.exists(_LOCAL):
        with open(_LOCAL, "rb") as f:
            return f.read()
    return None


def info_codigos():
    try:
        items = get_supabase_client().storage.from_(BUCKET).list()
        for it in items:
            name = it.get("name") if isinstance(it, dict) else getattr(it, "name", None)
            if name == CODIGOS_KEY:
                meta = (it.get("metadata") if isinstance(it, dict) else getattr(it, "metadata", None)) or {}
                return {"exists": True, "size": meta.get("size")}
    except Exception:
        pass
    if os.path.exists(_LOCAL):
        return {"exists": True, "size": os.stat(_LOCAL).st_size}
    return {"exists": False}
