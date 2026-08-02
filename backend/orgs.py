# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Multiempresa: empresas (despachos) y membresías usuario ↔ empresa.

El sistema tenía un solo nivel de aislamiento —el usuario suelto— y aquí se
agrega el que faltaba: la EMPRESA. Un usuario pertenece a una o varias empresas
(`organization_members`) y en CADA una tiene su propio rol, sus propios módulos
y sus propias pantallas permitidas.

Empresa ACTIVA de la petición
-----------------------------
El frontend manda la cabecera `X-Org-Id`. Un middleware la valida contra las
membresías del usuario y la deja en un ContextVar; de ahí la leen `access.py`
(permisos) y `tenancy.py` (visibilidad de contribuyentes) sin tener que pasarla
a mano por los ~30 routers que ya existen.

Modo HEREDADO
-------------
Si las tablas de la migración 051 todavía no están creadas, o el usuario no
tiene ninguna membresía, todas las funciones devuelven None y el sistema sigue
comportándose exactamente como antes (permisos globales por usuario). Es lo que
permite desplegar este código antes de aplicar el SQL.
"""
import time
from contextvars import ContextVar
from typing import Optional

from fastapi import HTTPException

from database import get_supabase_client

# Roles válidos DENTRO de una empresa, de mayor a menor privilegio.
ROLES_ORG = ("admin", "socio", "trabajador", "cliente")
ORDEN_ROL = {"admin": 0, "socio": 1, "trabajador": 2, "cliente": 3}

# Empresa activa de la petición en curso. Lo fija el middleware de main.py.
_org_activa: ContextVar[Optional[str]] = ContextVar("org_activa", default=None)

_TTL = 120  # seg — igual que el caché de rol/módulos de access.py

_cache_membresias: dict = {}   # user_id            -> (list, ts)
_cache_modulos: dict = {}      # (org_id, user_id)  -> (list|None, ts)
_cache_submodulos: dict = {}   # (org_id, user_id)  -> (set, ts)
_cache_admins_org: dict = {}   # org_id             -> (set, ts)
_cache_grants: dict = {}       # org_id (receptora) -> (dict, ts)

# Sondeo de existencia de las tablas: None = sin comprobar, True = existen.
# Si da False se reintenta pasado _TTL (puede haber sido un fallo de red, no
# una tabla ausente de verdad).
_tablas: Optional[bool] = None
_tablas_ts: float = 0.0


def _ahora() -> float:
    return time.monotonic()


# ---------------------------------------------------------------------------
# Empresa activa de la petición
# ---------------------------------------------------------------------------

def set_org_activa(org_id: Optional[str]) -> None:
    _org_activa.set(org_id)


def org_activa() -> Optional[str]:
    """Empresa de la petición en curso, o None en modo heredado."""
    return _org_activa.get()


# ---------------------------------------------------------------------------
# Disponibilidad del modelo multiempresa
# ---------------------------------------------------------------------------

def hay_multiempresa() -> bool:
    """True si la migración 051 ya está aplicada. Se sondea una sola vez."""
    global _tablas, _tablas_ts
    if _tablas is True:
        return True
    if _tablas is False and (_ahora() - _tablas_ts) < _TTL:
        return False
    try:
        get_supabase_client().table("organizations").select("id").limit(1).execute()
        _tablas = True
    except Exception:
        _tablas = False
    _tablas_ts = _ahora()
    return _tablas


# ---------------------------------------------------------------------------
# Membresías
# ---------------------------------------------------------------------------

def membresias(user_id: str) -> list:
    """Empresas a las que pertenece el usuario, con su rol en cada una.

    Devuelve [{org_id, nombre, identificacion, role, activa}], ordenado por
    privilegio y luego por nombre. Lista vacía = modo heredado."""
    hit = _cache_membresias.get(user_id)
    if hit and (_ahora() - hit[1]) < _TTL:
        return hit[0]
    if not hay_multiempresa():
        return []
    sb = get_supabase_client()
    try:
        filas = sb.table("organization_members").select("org_id,role")\
            .eq("user_id", user_id).execute().data or []
    except Exception:
        return []
    out = []
    if filas:
        ids = [f["org_id"] for f in filas]
        try:
            empresas = sb.table("organizations").select("id,nombre,identificacion,activa")\
                .in_("id", ids).execute().data or []
        except Exception:
            empresas = []
        por_id = {e["id"]: e for e in empresas}
        for f in filas:
            e = por_id.get(f["org_id"])
            if not e:
                continue  # empresa borrada: la membresía huérfana se ignora
            out.append({
                "org_id": f["org_id"],
                "nombre": e.get("nombre") or "",
                "identificacion": e.get("identificacion"),
                "activa": bool(e.get("activa", True)),
                "role": f.get("role") or "cliente",
            })
        out.sort(key=lambda m: (ORDEN_ROL.get(m["role"], 9), (m["nombre"] or "").upper()))
    _cache_membresias[user_id] = (out, _ahora())
    return out


def empresas_visibles(user_id: str, es_admin_plataforma: bool = False) -> list:
    """Empresas que el usuario puede elegir en el selector.

    El administrador de plataforma las ve TODAS (aunque no sea miembro), con el
    rol 'admin' en las que no tiene membresía explícita. El resto, solo aquellas
    en las que es miembro. Las empresas suspendidas (activa=false) no se listan
    salvo para el administrador de plataforma, que necesita poder reactivarlas."""
    propias = membresias(user_id)
    if not es_admin_plataforma:
        return [m for m in propias if m["activa"]]
    if not hay_multiempresa():
        return propias
    try:
        todas = get_supabase_client().table("organizations")\
            .select("id,nombre,identificacion,activa").execute().data or []
    except Exception:
        return propias
    rol_propio = {m["org_id"]: m["role"] for m in propias}
    out = [{
        "org_id": e["id"],
        "nombre": e.get("nombre") or "",
        "identificacion": e.get("identificacion"),
        "activa": bool(e.get("activa", True)),
        "role": rol_propio.get(e["id"], "admin"),
    } for e in todas]
    out.sort(key=lambda m: (m["nombre"] or "").upper())
    return out


def rol_en(user_id: str, org_id: Optional[str]) -> Optional[str]:
    """Rol del usuario DENTRO de esa empresa, o None si no es miembro."""
    if not org_id:
        return None
    for m in membresias(user_id):
        if m["org_id"] == org_id:
            return m["role"]
    return None


def es_miembro(user_id: str, org_id: Optional[str]) -> bool:
    return rol_en(user_id, org_id) is not None


def resolver_org(user_id: str, solicitada: Optional[str],
                 es_admin_plataforma: bool = False) -> Optional[str]:
    """Empresa activa para esta petición.

    · Si viene `X-Org-Id` y el usuario es miembro (o es admin de plataforma), esa.
    · Si viene una a la que NO pertenece, se ignora y se cae a la primera suya:
      así una cabecera manipulada nunca abre datos de otra empresa, y un
      `X-Org-Id` viejo guardado en el navegador no deja al usuario sin acceso.
    · Sin cabecera: su empresa de mayor privilegio.
    · Sin membresías: None (modo heredado)."""
    if not hay_multiempresa():
        return None
    propias = membresias(user_id)
    if solicitada:
        for m in propias:
            if m["org_id"] == solicitada and m["activa"]:
                return solicitada
        if es_admin_plataforma and _existe_org(solicitada):
            return solicitada
    activas = [m for m in propias if m["activa"]]
    if activas:
        return activas[0]["org_id"]
    return None


def _existe_org(org_id: str) -> bool:
    try:
        r = get_supabase_client().table("organizations").select("id")\
            .eq("id", org_id).limit(1).execute().data
        return bool(r)
    except Exception:
        return False


def asegurar_miembro(user_id: str, org_id: str, es_admin_plataforma: bool = False) -> str:
    """Rol del usuario en la empresa, o 403 si no pertenece a ella."""
    rol = rol_en(user_id, org_id)
    if rol:
        return rol
    if es_admin_plataforma and _existe_org(org_id):
        return "admin"
    raise HTTPException(status_code=403, detail="No perteneces a esta empresa")


# ---------------------------------------------------------------------------
# Permisos por membresía (módulos y submódulos)
# ---------------------------------------------------------------------------

def modulos_en(user_id: str, org_id: Optional[str]) -> Optional[list]:
    """Módulos activos del usuario EN esa empresa.

    None significa "esta membresía no tiene permisos propios definidos" → quien
    llama debe caer a los módulos globales del usuario (user_modules). Una lista
    vacía, en cambio, sí es una respuesta: no tiene ningún módulo aquí."""
    if not org_id or not hay_multiempresa():
        return None
    clave = (org_id, user_id)
    hit = _cache_modulos.get(clave)
    if hit and (_ahora() - hit[1]) < _TTL:
        return hit[0]
    try:
        filas = get_supabase_client().table("organization_member_modules")\
            .select("modulo,activo,valid_until")\
            .eq("org_id", org_id).eq("user_id", user_id).execute().data or []
    except Exception:
        return None
    if not filas:
        resultado = None
    else:
        from datetime import date
        hoy = date.today().isoformat()
        resultado = [f["modulo"] for f in filas
                     if f.get("activo")
                     and not (f.get("valid_until") and str(f["valid_until"]) < hoy)]
    _cache_modulos[clave] = (resultado, _ahora())
    return resultado


def submodulos_guardados_en(user_id: str, org_id: Optional[str]) -> Optional[set]:
    """Submódulos con restricción guardada para esa membresía.

    Misma semántica que user_submodules: sin filas para los submódulos de un
    módulo = todas sus pantallas permitidas. None = modo heredado."""
    if not org_id or not hay_multiempresa():
        return None
    clave = (org_id, user_id)
    hit = _cache_submodulos.get(clave)
    if hit and (_ahora() - hit[1]) < _TTL:
        return hit[0]
    try:
        filas = get_supabase_client().table("organization_member_submodules")\
            .select("submodulo").eq("org_id", org_id).eq("user_id", user_id)\
            .execute().data or []
    except Exception:
        return None
    guardados = {f["submodulo"] for f in filas}
    _cache_submodulos[clave] = (guardados, _ahora())
    return guardados


def admins_de_org(org_id: Optional[str]) -> set:
    """user_id de los administradores de la empresa.

    tenancy.py lo usa para la regla del socio: "lo que crea un administrador solo
    lo ve otro administrador". Antes esa regla miraba a los admins GLOBALES; con
    empresas pasa a ser por empresa."""
    if not org_id or not hay_multiempresa():
        return set()
    hit = _cache_admins_org.get(org_id)
    if hit and (_ahora() - hit[1]) < _TTL:
        return hit[0]
    try:
        filas = get_supabase_client().table("organization_members")\
            .select("user_id").eq("org_id", org_id).eq("role", "admin")\
            .execute().data or []
    except Exception:
        return set()
    ids = {f["user_id"] for f in filas}
    _cache_admins_org[org_id] = (ids, _ahora())
    return ids


def autorizaciones_recibidas(org_id: Optional[str]) -> dict:
    """Lo que OTRAS empresas autorizaron a ver a `org_id` (migración 052).

    Devuelve {"carteras": set(owner_org_id), "identificaciones": set(RUC)}:
      · carteras         → empresas que abrieron su cartera COMPLETA
      · identificaciones → contribuyentes sueltos autorizados, por RUC
    Sin autorizaciones (o sin la tabla creada) devuelve conjuntos vacíos, con lo
    que la frontera entre empresas queda tal cual la dejó la 051."""
    if not org_id or not hay_multiempresa():
        return {"carteras": set(), "identificaciones": set()}
    hit = _cache_grants.get(org_id)
    if hit and (_ahora() - hit[1]) < _TTL:
        return hit[0]
    try:
        filas = get_supabase_client().table("organization_grants")\
            .select("owner_org_id,identificacion").eq("grantee_org_id", org_id)\
            .execute().data or []
    except Exception:
        # Tabla aún no creada: sin autorizaciones, que es el lado seguro.
        return {"carteras": set(), "identificaciones": set()}
    out = {"carteras": set(), "identificaciones": set()}
    for f in filas:
        if f.get("identificacion"):
            out["identificaciones"].add(f["identificacion"])
        else:
            out["carteras"].add(f["owner_org_id"])
    _cache_grants[org_id] = (out, _ahora())
    return out


def hay_autorizaciones(org_id: Optional[str]) -> bool:
    """True si la empresa activa recibió alguna autorización. Sirve para no
    pagar el coste de la consulta extra de contribuyentes cuando no hay ninguna,
    que es el caso normal."""
    a = autorizaciones_recibidas(org_id)
    return bool(a["carteras"] or a["identificaciones"])


def suscripcion_de_org(org_id: Optional[str]) -> Optional[dict]:
    """Suscripción contratada por la EMPRESA, o None si no tiene una propia
    (en ese caso manda la del usuario, como hasta ahora)."""
    if not org_id or not hay_multiempresa():
        return None
    try:
        r = get_supabase_client().table("subscriptions").select("*")\
            .eq("org_id", org_id).limit(1).execute().data
    except Exception:
        return None
    return r[0] if r else None


# ---------------------------------------------------------------------------
# Invalidación de cachés
# ---------------------------------------------------------------------------

def invalidar(user_id: str = None, org_id: str = None) -> None:
    """Limpia los cachés tras un cambio de membresía, rol o permisos.

    Sin argumentos limpia todo. Con org_id se limpian también las membresías de
    TODOS los usuarios, porque un cambio en la empresa (renombrarla, suspenderla)
    afecta a lo que ve cada miembro."""
    if user_id is None and org_id is None:
        _cache_membresias.clear()
        _cache_modulos.clear()
        _cache_submodulos.clear()
        _cache_admins_org.clear()
        _cache_grants.clear()
        return
    # Una autorización cambia lo que ve la empresa RECEPTORA, que no es la que
    # se está tocando: se limpian todas para no dejar a nadie con una vista vieja.
    _cache_grants.clear()
    if user_id:
        _cache_membresias.pop(user_id, None)
        for clave in [k for k in _cache_modulos if k[1] == user_id]:
            _cache_modulos.pop(clave, None)
        for clave in [k for k in _cache_submodulos if k[1] == user_id]:
            _cache_submodulos.pop(clave, None)
    if org_id:
        _cache_admins_org.pop(org_id, None)
        _cache_membresias.clear()
        for clave in [k for k in _cache_modulos if k[0] == org_id]:
            _cache_modulos.pop(clave, None)
        for clave in [k for k in _cache_submodulos if k[0] == org_id]:
            _cache_submodulos.pop(clave, None)
