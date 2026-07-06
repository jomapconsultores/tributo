"""Control de acceso por módulos contratados (Fase 2 multi-tenant).

Cada usuario tiene un conjunto de módulos activos en `user_modules`. Los admins
(`app_admins`) tienen todos los módulos. `require_module(...)` se usa como
dependencia de router para bloquear (403) el acceso a módulos no contratados.
"""
import time
from datetime import date
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client

router = APIRouter(prefix="/api/access", tags=["access"])

MODULOS = ["gastos", "retenciones", "ingresos_ice", "declaraciones", "agente_retencion"]

# Catálogo de SUBMÓDULOS (pantallas sueltas dentro de cada módulo). El
# administrador puede restringir a un usuario a un subconjunto de estas
# pantallas. Regla: si el usuario NO tiene ninguna fila de user_submodules para
# los submódulos de un módulo, se consideran TODOS permitidos (retrocompatible).
# Los módulos de una sola pantalla (retenciones) no se listan aquí.
SUBMODULOS = {
    "gastos": [
        {"key": "gastos_facturas", "label": "Gastos y datos guardados"},
        {"key": "gastos_clasificar", "label": "Clasificador de gastos"},
    ],
    "ingresos_ice": [
        {"key": "ice_calculo", "label": "Cálculo previo ICE"},
        {"key": "ice_anexo", "label": "Anexo PVP+ICE"},
        {"key": "ice_xml", "label": "Ingresos ICE (XML)"},
        {"key": "ice_catalogo", "label": "Catálogo de productos"},
        {"key": "ice_rebajas", "label": "Rebajas y exenciones"},
        {"key": "ice_compradores", "label": "Compradores"},
        {"key": "ice_ingresos_iva", "label": "Ingresos IVA"},
    ],
    "declaraciones": [
        {"key": "decl_iva", "label": "Declaración IVA"},
        {"key": "decl_ice", "label": "Declaración ICE"},
        {"key": "decl_devoluciones", "label": "Devoluciones IVA (adultos mayores)"},
    ],
    "agente_retencion": [
        {"key": "agret_retenciones", "label": "Retenciones efectuadas"},
        {"key": "agret_103", "label": "Declaración 103 (Renta)"},
    ],
}
# key de submódulo → módulo padre
SUBMODULO_MODULO = {s["key"]: mod for mod, subs in SUBMODULOS.items() for s in subs}
# módulo → set de todas las keys de sus submódulos
_SUBS_POR_MODULO = {mod: {s["key"] for s in subs} for mod, subs in SUBMODULOS.items()}

# ---------------------------------------------------------------------------
# Caché en memoria para rol y módulos. Evita 1-3 consultas BD por request.
# TTL corto (2 min) para que cambios de rol/suscripción surtan efecto pronto.
# ---------------------------------------------------------------------------
_role_cache: dict = {}   # user_id → (role, ts)
_access_cache: dict = {} # user_id → (sub_dict, modules_list, ts)
_submod_cache: dict = {} # user_id → (permitidos_dict, ts)
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
        # OJO: si hay fila pero el campo role viene vacío/null, el default debe
        # ser el MENOS privilegiado ('socio', no 'admin') — antes, por
        # precedencia de operadores ("x or 'admin' if r else 'cliente'" se lee
        # como "(x or 'admin') if r else 'cliente'"), un role vacío escalaba a
        # admin en silencio.
        role = (r[0].get("role") or "socio") if r else "cliente"
    except Exception:
        role = "cliente"
    _role_cache[user_id] = (role, _now())
    return role


def invalidar_cache_rol(user_id: str = None):
    """Limpia el caché de rol/módulos/submódulos tras cambio administrativo."""
    if user_id:
        _role_cache.pop(user_id, None)
        _access_cache.pop(user_id, None)
        _submod_cache.pop(user_id, None)
    else:
        _role_cache.clear()
        _access_cache.clear()
        _submod_cache.clear()


def es_admin(user_id: str) -> bool:
    """True para administradores Y socios (acceso operativo completo)."""
    return rol_de(user_id) in ("admin", "socio")


def es_super_admin(user_id: str) -> bool:
    """True solo para el administrador máximo (gestiona roles)."""
    return rol_de(user_id) == "admin"


def es_data_admin(user_id: str) -> bool:
    """True solo para 'admin': puede ver datos de TODOS los usuarios.
    'socio' tiene acceso a todos los módulos pero solo ve sus propios datos."""
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

    if es_super_admin(user_id):
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


# ---------------------------------------------------------------------------
# Roles múltiples: un usuario puede tener VARIOS roles otorgados (tabla
# user_roles) y cambiar entre ellos. app_admins guarda el rol ACTIVO (lo que
# lee rol_de); user_roles guarda el CONJUNTO otorgado por el administrador.
# ---------------------------------------------------------------------------
_ROL_ORDEN = {"admin": 0, "socio": 1, "trabajador": 2, "cliente": 3}
_ROLES_VALIDOS = ("admin", "socio", "trabajador", "cliente")


def roles_otorgados(user_id: str) -> set:
    """Conjunto de roles que el administrador le otorgó (tabla user_roles).
    Vacío si es un usuario normal (solo tendrá su rol propio, ver abajo)."""
    try:
        rows = get_supabase_client().table("user_roles").select("role").eq("user_id", user_id).execute().data or []
    except Exception:
        rows = []
    return {r["role"] for r in rows}


def roles_asumibles(user_id: str) -> list:
    """Roles entre los que el usuario PUEDE cambiar. Siempre incluye su rol
    activo actual (rol_de), aunque no esté en user_roles. Ordenados de mayor a
    menor privilegio. Un usuario sin roles múltiples otorgados obtiene una sola
    entrada (su propio rol) → el frontend no muestra el selector."""
    roles = roles_otorgados(user_id)
    roles.add(rol_de(user_id))
    return sorted(roles, key=lambda r: _ROL_ORDEN.get(r, 9))


def cambiar_rol_activo(user_id: str, target: str) -> str:
    """Cambia el rol ACTIVO del usuario re-apuntando app_admins. Solo permite
    roles que ya le fueron otorgados (self-service, no escala privilegios)."""
    target = (target or "").strip().lower()
    if target not in _ROLES_VALIDOS:
        raise HTTPException(status_code=400, detail="Rol inválido (admin | socio | trabajador | cliente)")
    # Validación ESTRICTA contra el conjunto que fijó el administrador (user_roles),
    # no contra la unión con el rol activo: así una divergencia futura
    # app_admins/user_roles nunca queda auto-conmutable (defensa en profundidad).
    if target not in roles_otorgados(user_id):
        raise HTTPException(status_code=403, detail="No tienes ese rol otorgado por el administrador")
    sb = get_supabase_client()
    if target == "cliente":
        # 'cliente' = ausencia de fila en app_admins. user_roles conserva el
        # conjunto, así que puede volver a subir de rol después.
        sb.table("app_admins").delete().eq("user_id", user_id).execute()
    else:
        existing = sb.table("app_admins").select("user_id").eq("user_id", user_id).execute().data
        if existing:
            sb.table("app_admins").update({"role": target}).eq("user_id", user_id).execute()
        else:
            sb.table("app_admins").insert({"user_id": user_id, "role": target}).execute()
    invalidar_cache_rol(user_id)
    # La visibilidad de datos depende del rol → limpiar también el cache de clientes.
    try:
        from tenancy import invalidate_clients_cache
        invalidate_clients_cache(user_id)
    except Exception:
        pass
    return target


class SwitchRoleIn(BaseModel):
    role: str


@router.post("/switch-role")
async def switch_role(body: SwitchRoleIn, user_id: str = Depends(get_current_user)):
    """El propio usuario cambia su rol activo, SOLO entre los roles que el
    administrador le otorgó (user_roles). Devuelve el estado de acceso ya
    recalculado con el rol nuevo."""
    nuevo = cambiar_rol_activo(user_id, body.role)
    sub, mods = _cargar_acceso(user_id)
    return {
        "role": nuevo,
        "roles": roles_asumibles(user_id),
        "modules": mods,
        "is_admin": es_admin(user_id),
    }


def require_module(modulo: str):
    async def dep(user_id: str = Depends(get_current_user)):
        if modulo not in modulos_de(user_id):
            raise HTTPException(status_code=403, detail=f"Módulo no contratado: {modulo}")
        return user_id
    return dep


# ---------------------------------------------------------------------------
# Submódulos: pantallas sueltas dentro de un módulo. Default = TODO permitido
# si el admin no restringió (retrocompatible). La restricción guarda en
# user_submodules el SUBCONJUNTO permitido de ese módulo.
# ---------------------------------------------------------------------------
def submodulos_permitidos(user_id: str) -> dict:
    """dict módulo → set(keys de submódulo permitidos). Si el usuario no tiene
    ninguna fila para los submódulos de un módulo, se permiten TODOS. Cacheado."""
    hit = _submod_cache.get(user_id)
    if hit and _now() - hit[1] < _TTL:
        return hit[0]
    try:
        rows = get_supabase_client().table("user_submodules").select("submodulo").eq("user_id", user_id).execute().data or []
    except Exception:
        rows = []
    guardados = {r["submodulo"] for r in rows}
    out = {}
    for mod, keys in _SUBS_POR_MODULO.items():
        permitidos_mod = guardados & keys
        out[mod] = permitidos_mod if permitidos_mod else set(keys)  # sin filas = todos
    _submod_cache[user_id] = (out, _now())
    return out


def submodulos_de(user_id: str) -> list:
    """Lista plana de todos los submódulos permitidos para el usuario (solo de
    los módulos que tiene contratados). Para /me y el frontend."""
    if es_super_admin(user_id):
        return list(SUBMODULO_MODULO.keys())
    mods = set(modulos_de(user_id))
    perm = submodulos_permitidos(user_id)
    out = []
    for mod, keys in perm.items():
        if mod in mods:
            out.extend(keys)
    return out


def puede_submodulo(user_id: str, sub: str) -> bool:
    modulo = SUBMODULO_MODULO.get(sub)
    if not modulo:
        return True  # submódulo no catalogado → no se restringe
    if es_super_admin(user_id):
        return True
    return sub in submodulos_permitidos(user_id).get(modulo, set())


def require_submodule(sub: str):
    """Dependencia de router: valida el MÓDULO padre Y el submódulo. Reemplaza a
    require_module en los routers que corresponden a una sola pantalla."""
    modulo = SUBMODULO_MODULO.get(sub)

    async def dep(user_id: str = Depends(get_current_user)):
        if modulo and modulo not in modulos_de(user_id):
            raise HTTPException(status_code=403, detail=f"Módulo no contratado: {modulo}")
        if not puede_submodulo(user_id, sub):
            raise HTTPException(status_code=403, detail=f"Pantalla no habilitada: {sub}")
        return user_id
    return dep


@router.get("/me")
async def me(user_id: str = Depends(get_current_user)):
    """Módulos del usuario actual + si es administrador + estado de suscripción."""
    sub, mods = _cargar_acceso(user_id)
    return {
        "modules": mods,
        "submodules": submodulos_de(user_id),   # pantallas permitidas (default = todas)
        "is_admin": es_admin(user_id),
        "role": rol_de(user_id),
        "roles": roles_asumibles(user_id),   # roles entre los que puede cambiar
        "subscription": {
            "estado": sub.get("estado"),
            "plan": sub.get("plan"),
            "proximo_pago": sub.get("proximo_pago"),
            "precio_mensual": sub.get("precio_mensual"),
            "vigente": sub.get("vigente", True),
            "vencida": sub.get("vencida", False),
        },
    }
