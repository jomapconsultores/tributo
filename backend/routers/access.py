"""Control de acceso por módulos contratados (Fase 2 multi-tenant).

Cada usuario tiene un conjunto de módulos activos en `user_modules`. Los admins
(`app_admins`) tienen todos los módulos. `require_module(...)` se usa como
dependencia de router para bloquear (403) el acceso a módulos no contratados.
"""
import time
from datetime import date
from fastapi import APIRouter, Depends, HTTPException
from auth import get_current_user
from database import get_supabase_client

router = APIRouter(prefix="/api/access", tags=["access"])

MODULOS = ["gastos", "retenciones", "ingresos_ice", "declaraciones"]

# ---------------------------------------------------------------------------
# Caché en memoria para rol y módulos. Evita 1-3 consultas BD por request.
# TTL corto (2 min) para que cambios de rol/suscripción surtan efecto pronto.
# ---------------------------------------------------------------------------
_role_cache: dict = {}   # user_id → (role, ts)
_access_cache: dict = {} # user_id → (sub_dict, modules_list, ts)
_TTL = 120               # segundos


def _now():
    return time.monotonic()


# Jerarquía de roles: 'admin' (máximo) → 'socio' → 'cliente'.
# admin y socio comparten el acceso operativo (es_admin = True para ambos);
# solo el 'admin' (super) puede gestionar roles de otros usuarios.
def rol_de(user_id: str) -> str:
    """Devuelve 'admin', 'socio' o 'cliente'. Resultado cacheado 2 min."""
    hit = _role_cache.get(user_id)
    if hit and _now() - hit[1] < _TTL:
        return hit[0]
    try:
        r = get_supabase_client().table("app_admins").select("role").eq("user_id", user_id).execute().data
        role = r[0].get("role") or "admin" if r else "cliente"
    except Exception:
        role = "cliente"
    _role_cache[user_id] = (role, _now())
    return role


def invalidar_cache_rol(user_id: str = None):
    """Limpia el caché de rol tras cambio administrativo."""
    if user_id:
        _role_cache.pop(user_id, None)
        _access_cache.pop(user_id, None)
    else:
        _role_cache.clear()
        _access_cache.clear()


def es_admin(user_id: str) -> bool:
    """True para administradores Y socios (acceso operativo completo)."""
    return rol_de(user_id) in ("admin", "socio")


def es_super_admin(user_id: str) -> bool:
    """True solo para el administrador máximo (gestiona roles)."""
    return rol_de(user_id) == "admin"


def suscripcion(user_id: str):
    """Devuelve la suscripción del usuario con un flag 'vigente'.
    Sin suscripción registrada => vigente=True (no bloquea, compatibilidad)."""
    try:
        r = get_supabase_client().table("subscriptions").select("*").eq("user_id", user_id).execute().data
    except Exception:
        r = None
    if not r:
        return {"estado": None, "plan": None, "proximo_pago": None, "precio_mensual": None, "vigente": True}
    s = r[0]
    hoy = date.today().isoformat()
    vencida = bool(s.get("proximo_pago")) and str(s["proximo_pago"]) < hoy
    vigente = s.get("estado") != "suspendido" and not vencida
    s["vigente"] = vigente
    s["vencida"] = vencida
    return s


def _cargar_acceso(user_id: str):
    """Carga (y cachea) suscripción + módulos en una sola pasada."""
    hit = _access_cache.get(user_id)
    if hit and _now() - hit[2] < _TTL:
        return hit[0], hit[1]

    if es_admin(user_id):
        sub = suscripcion(user_id)
        mods = list(MODULOS)
        _access_cache[user_id] = (sub, mods, _now())
        return sub, mods

    sub = suscripcion(user_id)
    if not sub.get("vigente", True):
        _access_cache[user_id] = (sub, [], _now())
        return sub, []

    try:
        rows = get_supabase_client().table("user_modules").select("modulo,activo,valid_until")\
            .eq("user_id", user_id).eq("activo", True).execute().data or []
    except Exception:
        rows = []
    hoy = date.today().isoformat()
    mods = [r["modulo"] for r in rows if not (r.get("valid_until") and str(r["valid_until"]) < hoy)]
    _access_cache[user_id] = (sub, mods, _now())
    return sub, mods


def modulos_de(user_id: str):
    _, mods = _cargar_acceso(user_id)
    return mods


def require_module(modulo: str):
    async def dep(user_id: str = Depends(get_current_user)):
        if modulo not in modulos_de(user_id):
            raise HTTPException(status_code=403, detail=f"Módulo no contratado: {modulo}")
        return user_id
    return dep


@router.get("/me")
async def me(user_id: str = Depends(get_current_user)):
    """Módulos del usuario actual + si es administrador + estado de suscripción."""
    sub, mods = _cargar_acceso(user_id)
    return {
        "modules": mods,
        "is_admin": es_admin(user_id),
        "role": rol_de(user_id),
        "subscription": {
            "estado": sub.get("estado"),
            "plan": sub.get("plan"),
            "proximo_pago": sub.get("proximo_pago"),
            "precio_mensual": sub.get("precio_mensual"),
            "vigente": sub.get("vigente", True),
            "vencida": sub.get("vencida", False),
        },
    }
