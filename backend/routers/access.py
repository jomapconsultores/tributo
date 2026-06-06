"""Control de acceso por módulos contratados (Fase 2 multi-tenant).

Cada usuario tiene un conjunto de módulos activos en `user_modules`. Los admins
(`app_admins`) tienen todos los módulos. `require_module(...)` se usa como
dependencia de router para bloquear (403) el acceso a módulos no contratados.
"""
from datetime import date
from fastapi import APIRouter, Depends, HTTPException
from auth import get_current_user
from database import get_supabase_client

router = APIRouter(prefix="/api/access", tags=["access"])

MODULOS = ["gastos", "retenciones", "ingresos_ice", "declaraciones"]


def es_admin(user_id: str) -> bool:
    try:
        r = get_supabase_client().table("app_admins").select("user_id").eq("user_id", user_id).execute()
        return bool(r.data)
    except Exception:
        return False


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


def modulos_de(user_id: str):
    if es_admin(user_id):
        return list(MODULOS)
    # Bloqueo por cobro: si la suscripción no está vigente, sin módulos
    if not suscripcion(user_id).get("vigente", True):
        return []
    try:
        rows = get_supabase_client().table("user_modules").select("modulo,activo,valid_until")\
            .eq("user_id", user_id).eq("activo", True).execute().data or []
    except Exception:
        return []
    hoy = date.today().isoformat()
    out = []
    for r in rows:
        vu = r.get("valid_until")
        if vu and str(vu) < hoy:
            continue
        out.append(r["modulo"])
    return out


def require_module(modulo: str):
    async def dep(user_id: str = Depends(get_current_user)):
        if modulo not in modulos_de(user_id):
            raise HTTPException(status_code=403, detail=f"Módulo no contratado: {modulo}")
        return user_id
    return dep


@router.get("/me")
async def me(user_id: str = Depends(get_current_user)):
    """Módulos del usuario actual + si es administrador + estado de suscripción."""
    sub = suscripcion(user_id)
    return {
        "modules": modulos_de(user_id),
        "is_admin": es_admin(user_id),
        "subscription": {
            "estado": sub.get("estado"),
            "plan": sub.get("plan"),
            "proximo_pago": sub.get("proximo_pago"),
            "precio_mensual": sub.get("precio_mensual"),
            "vigente": sub.get("vigente", True),
            "vencida": sub.get("vencida", False),
        },
    }
