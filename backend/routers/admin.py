"""Panel de administración (Fase 3). Solo para admins (app_admins).
Permite listar/crear usuarios y asignar módulos/planes con vigencia."""
from datetime import date, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from auth import get_current_user
from database import get_supabase_client
from routers.access import es_admin, es_super_admin, rol_de, MODULOS, SUBMODULOS, invalidar_cache_rol

# módulo → set de keys de submódulo (para reconciliar restricciones)
_SUBS_KEYS = {mod: {s["key"] for s in subs} for mod, subs in SUBMODULOS.items()}


def _submodulos_permitidos_de(guardados: set) -> set:
    """Dado el conjunto de submódulos GUARDADOS (restricción) de un usuario,
    devuelve la lista plana PERMITIDA: por cada módulo, el subconjunto guardado
    o TODOS si no hay ninguno (default = todo)."""
    out = set()
    for mod, keys in _SUBS_KEYS.items():
        a = guardados & keys
        out |= (a if a else keys)
    return out

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Cada "mes" = 30 días exactos. Descuentos por pago anticipado.
DIAS_MES = 30
DESCUENTOS = {1: 0.0, 3: 0.05, 6: 0.10, 12: 0.25}

# Paquetes → módulos que activan
PLANES = {
    "ice": ["ingresos_ice"],
    "gastos_ret": ["gastos", "retenciones"],
    "completo": ["gastos", "retenciones", "ingresos_ice", "declaraciones"],
}
# Precio neto mensual (sin IVA) por plan
PLAN_PRECIO = {"ice": 50, "gastos_ret": 50, "completo": 150}


async def require_admin(user_id: str = Depends(get_current_user)):
    if not es_super_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo el administrador principal")
    return user_id


async def require_super_admin(user_id: str = Depends(get_current_user)):
    """Solo el administrador máximo (no socios): gestión de roles."""
    if not es_super_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo el administrador puede gestionar roles")
    return user_id


class RoleIn(BaseModel):
    role: str   # 'admin' | 'socio' | 'cliente'


class RolesIn(BaseModel):
    roles: List[str]   # conjunto otorgado, p.ej. ['admin', 'cliente']


_ROL_ORDEN = {"admin": 0, "socio": 1, "cliente": 2}


class ClientAccessIn(BaseModel):
    identificacion: str
    granted_to: str          # user_id del beneficiario
    grant: bool              # True = otorgar, False = revocar
    owner_user_id: Optional[str] = None  # ignorado — se busca por identificacion en todos los propietarios


class UserIn(BaseModel):
    email: str
    password: str
    modules: Optional[List[str]] = None
    plan: Optional[str] = None


class ModulesIn(BaseModel):
    modules: List[str]
    valid_until: Optional[str] = None


class PlanIn(BaseModel):
    plan: str
    valid_until: Optional[str] = None


class SubIn(BaseModel):
    plan: Optional[str] = None
    precio_mensual: Optional[float] = None
    estado: Optional[str] = None          # prueba | activo | suspendido
    proximo_pago: Optional[str] = None    # YYYY-MM-DD
    iva_incluido: Optional[bool] = None   # True = precios de este cliente ya incluyen IVA


class PagoIn(BaseModel):
    monto: float = 0
    meses: int = 1                 # 1, 3, 6 o 12 (pago anticipado)
    fecha: Optional[str] = None
    periodo: Optional[str] = None
    metodo: Optional[str] = None
    nota: Optional[str] = None
    avanzar_mes: bool = True
    iva_incluido: Optional[bool] = None  # None = usar config del cliente; True/False = override


def _aplicar_modulos(uid: str, modules: List[str], valid_until: Optional[str]):
    """Activa los módulos de la lista y desactiva el resto, para un usuario."""
    sb = get_supabase_client()
    activos = set(modules or [])
    for m in MODULOS:
        data = {"activo": m in activos, "valid_until": valid_until}
        existing = sb.table("user_modules").select("id").eq("user_id", uid).eq("modulo", m).execute().data
        if existing:
            sb.table("user_modules").update(data).eq("id", existing[0]["id"]).execute()
        else:
            sb.table("user_modules").insert({"user_id": uid, "modulo": m, **data}).execute()


@router.get("/users")
async def list_users(_: str = Depends(require_admin)):
    sb = get_supabase_client()
    try:
        res = sb.auth.admin.list_users()
        users = res if isinstance(res, list) else getattr(res, "users", []) or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo listar usuarios: {e}")

    mods = sb.table("user_modules").select("user_id,modulo,activo,valid_until").execute().data or []
    admin_rows = sb.table("app_admins").select("user_id,role").execute().data or []
    roles = {a["user_id"]: (a.get("role") or "admin") for a in admin_rows}
    admins = set(roles.keys())
    # Conjunto de roles OTORGADOS por usuario (para las casillas del panel)
    role_set_rows = sb.table("user_roles").select("user_id,role").execute().data or []
    roles_set = {}
    for r in role_set_rows:
        roles_set.setdefault(r["user_id"], set()).add(r["role"])
    # Submódulos permitidos por usuario (restricciones en user_submodules)
    subrows = sb.table("user_submodules").select("user_id,submodulo").execute().data or []
    subs_guardados = {}
    for r in subrows:
        subs_guardados.setdefault(r["user_id"], set()).add(r["submodulo"])
    subs = {s["user_id"]: s for s in (sb.table("subscriptions").select("user_id,plan,precio_mensual,estado,proximo_pago,iva_incluido").execute().data or [])}
    ip_rows = sb.table("user_ips").select("user_id").execute().data or []
    ip_count = {}
    for r in ip_rows:
        ip_count[r["user_id"]] = ip_count.get(r["user_id"], 0) + 1
    by_user = {}
    for m in mods:
        by_user.setdefault(m["user_id"], {})[m["modulo"]] = {"activo": m["activo"], "valid_until": m.get("valid_until")}

    hoy = date.today().isoformat()
    out = []
    for u in users:
        uid = str(u.id)
        s = subs.get(uid)
        if s:
            vencida = bool(s.get("proximo_pago")) and str(s["proximo_pago"]) < hoy
            sub = {"plan": s.get("plan"), "precio_mensual": s.get("precio_mensual"),
                   "estado": s.get("estado"), "proximo_pago": s.get("proximo_pago"),
                   "iva_incluido": bool(s.get("iva_incluido")), "vencida": vencida}
        else:
            sub = None
        out.append({
            "user_id": uid,
            "email": u.email,
            "created_at": str(u.created_at)[:10],
            "is_admin": uid in admins,
            "role": roles.get(uid, "cliente"),   # rol ACTIVO
            "roles": sorted(roles_set.get(uid) or {roles.get(uid, "cliente")}, key=lambda r: _ROL_ORDEN.get(r, 9)),  # conjunto OTORGADO
            "submodules": sorted(_submodulos_permitidos_de(subs_guardados.get(uid, set()))),  # pantallas PERMITIDAS
            "modules": by_user.get(uid, {}),
            "subscription": sub,
            "ips": ip_count.get(uid, 0),
        })
    out.sort(key=lambda x: x["email"] or "")
    return out


def _upsert_sub(uid: str, data: dict):
    sb = get_supabase_client()
    data = {k: v for k, v in data.items() if v is not None}
    data["updated_at"] = "now()"
    existing = sb.table("subscriptions").select("user_id").eq("user_id", uid).execute().data
    if existing:
        sb.table("subscriptions").update(data).eq("user_id", uid).execute()
    else:
        data["user_id"] = uid
        sb.table("subscriptions").insert(data).execute()


@router.put("/users/{uid}/subscription")
async def set_subscription(uid: str, body: SubIn, _: str = Depends(require_admin)):
    _upsert_sub(uid, body.dict())
    return {"ok": True}


@router.post("/users/{uid}/pago")
async def registrar_pago(uid: str, body: PagoIn, _: str = Depends(require_admin)):
    sb = get_supabase_client()
    meses = body.meses if body.meses in DESCUENTOS else 1
    fecha = body.fecha or date.today().isoformat()
    periodo = body.periodo or (f"{meses} mes(es)")
    # Si no se especifica en el payload, usar la configuración guardada del cliente
    if body.iva_incluido is None:
        sub = sb.table("subscriptions").select("iva_incluido").eq("user_id", uid).execute().data
        iva_incluido = bool(sub[0].get("iva_incluido")) if sub else False
    else:
        iva_incluido = body.iva_incluido
    monto_final = round(body.monto, 2) if iva_incluido else round(body.monto * 1.15, 2)
    sb.table("pagos").insert({
        "user_id": uid, "monto": monto_final, "fecha": fecha,
        "periodo": periodo, "metodo": body.metodo, "nota": body.nota,
    }).execute()
    sub_upd = {"estado": "activo"}
    if body.avanzar_mes:
        cur = sb.table("subscriptions").select("proximo_pago").eq("user_id", uid).execute().data
        base = None
        if cur and cur[0].get("proximo_pago"):
            try:
                y, m, d = map(int, str(cur[0]["proximo_pago"]).split("-"))
                base = date(y, m, d)
            except Exception:
                base = None
        hoy = date.today()
        if not base or base < hoy:
            base = hoy
        sub_upd["proximo_pago"] = (base + timedelta(days=DIAS_MES * meses)).isoformat()
    _upsert_sub(uid, sub_upd)
    return {"ok": True, "proximo_pago": sub_upd.get("proximo_pago")}


@router.get("/descuentos")
async def descuentos(_: str = Depends(require_admin)):
    """Tabla de descuentos por pago anticipado (meses -> % descuento). El
    frontend la usa para el desplegable de meses en el modal de registrar pago,
    en vez de mantener una copia propia que podría desincronizarse de esta."""
    return {"descuentos": DESCUENTOS}


@router.get("/precio")
async def precio_sugerido(plan: str, meses: int = 1, _: str = Depends(require_admin)):
    """Calcula el monto sugerido (neto, con descuento por anticipo)."""
    neto = PLAN_PRECIO.get(plan.lower())
    if neto is None:
        raise HTTPException(status_code=400, detail="Plan inválido")
    m = meses if meses in DESCUENTOS else 1
    desc = DESCUENTOS[m]
    base = neto * m
    total = round(base * (1 - desc), 2)
    return {"plan": plan, "meses": m, "neto_mensual": neto, "descuento": desc,
            "subtotal": base, "total": total}


@router.get("/users/{uid}/pagos")
async def historial_pagos(uid: str, _: str = Depends(require_admin)):
    sb = get_supabase_client()
    return {"data": sb.table("pagos").select("*").eq("user_id", uid).order("fecha", desc=True).execute().data or []}


@router.delete("/users/{uid}/ips")
async def reset_ips(uid: str, _: str = Depends(require_admin)):
    """Borra las IPs registradas de un usuario (para que pueda entrar desde otra)."""
    get_supabase_client().table("user_ips").delete().eq("user_id", uid).execute()
    return {"ok": True}


@router.get("/permisos")
async def resumen_permisos(_: str = Depends(require_admin)):
    """Resumen de módulos activos y clientes autorizados por usuario."""
    sb = get_supabase_client()
    try:
        res = sb.auth.admin.list_users()
        users = res if isinstance(res, list) else getattr(res, "users", []) or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo listar usuarios: {e}")

    admin_rows = sb.table("app_admins").select("user_id,role").execute().data or []
    roles = {a["user_id"]: (a.get("role") or "admin") for a in admin_rows}

    mods_rows = sb.table("user_modules").select("user_id,modulo,activo").execute().data or []
    mods_by_user: dict = {}
    for m in mods_rows:
        if m["activo"]:
            mods_by_user.setdefault(m["user_id"], []).append(m["modulo"])

    subs = {s["user_id"]: s for s in (sb.table("subscriptions").select(
        "user_id,plan,estado,proximo_pago").execute().data or [])}

    access_rows = sb.table("client_access").select("granted_to,client_id").execute().data or []
    access_by_user: dict = {}
    for a in access_rows:
        access_by_user.setdefault(a["granted_to"], []).append(a["client_id"])

    all_ids = list({cid for cids in access_by_user.values() for cid in cids})
    clients_map: dict = {}
    if all_ids:
        for c in (sb.table("clients").select("id,identificacion,nombre").in_("id", all_ids).execute().data or []):
            clients_map[c["id"]] = c

    out = []
    hoy = date.today().isoformat()
    for u in users:
        uid = str(u.id)
        role = roles.get(uid, "cliente")
        s = subs.get(uid)
        by_ruc: dict = {}
        for cid in access_by_user.get(uid, []):
            c = clients_map.get(cid)
            if c and c["identificacion"] not in by_ruc:
                by_ruc[c["identificacion"]] = c["nombre"] or c["identificacion"]
        clientes = sorted(
            [{"identificacion": ruc, "nombre": nombre} for ruc, nombre in by_ruc.items()],
            key=lambda x: (x["nombre"] or "").upper()
        )
        sub_info = None
        if s:
            sub_info = {
                "plan": s.get("plan"),
                "estado": s.get("estado"),
                "proximo_pago": s.get("proximo_pago"),
                "vencida": bool(s.get("proximo_pago")) and str(s["proximo_pago"]) < hoy,
            }
        out.append({
            "user_id": uid,
            "email": u.email,
            "role": role,
            "modulos_activos": sorted(mods_by_user.get(uid, [])),
            "clientes_autorizados": clientes,
            "subscription": sub_info,
        })
    out.sort(key=lambda x: x["email"] or "")
    return out


@router.get("/contactos")
async def listar_contactos(_: str = Depends(require_admin)):
    sb = get_supabase_client()
    return {"data": sb.table("contactos").select("*").order("created_at", desc=True).execute().data or []}


# ---------------------------------------------------------------------------
# MOVIMIENTOS — bitácora de actividad de los usuarios (auditoría para el admin)
# ---------------------------------------------------------------------------

@router.get("/actividad")
async def listar_actividad(
    _: str = Depends(require_admin),
    limit: int = Query(200, ge=1, le=1000),
    actor: Optional[str] = Query(None),
    identificacion: Optional[str] = Query(None),
    module: Optional[str] = Query(None),
):
    """Lista los movimientos registrados, del más reciente al más antiguo."""
    sb = get_supabase_client()
    q = sb.table("activity_log").select("*").order("occurred_at", desc=True).limit(limit)
    if actor:
        q = q.eq("actor_user_id", actor)
    if identificacion:
        q = q.eq("identificacion", identificacion)
    if module:
        q = q.eq("module", module)
    return {"data": q.execute().data or []}


@router.get("/actividad/resumen")
async def resumen_actividad(admin_id: str = Depends(require_admin)):
    """Cuántos movimientos nuevos hay desde la última vez que el admin los revisó.
    Sirve para la insignia (🔔) del sidebar."""
    sb = get_supabase_client()
    seen = sb.table("activity_seen").select("last_seen_at").eq("admin_user_id", admin_id).execute().data
    last_seen = seen[0]["last_seen_at"] if seen else None
    q = sb.table("activity_log").select("id", count="exact")
    if last_seen:
        q = q.gt("occurred_at", last_seen)
    res = q.execute()
    return {"nuevos": res.count or 0, "last_seen": last_seen}


@router.post("/actividad/visto")
async def marcar_actividad_vista(admin_id: str = Depends(require_admin)):
    """Marca todos los movimientos actuales como vistos (pone el contador en 0)."""
    from datetime import datetime, timezone
    sb = get_supabase_client()
    sb.table("activity_seen").upsert({
        "admin_user_id": admin_id,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="admin_user_id").execute()
    return {"ok": True}


@router.post("/users")
async def create_user(body: UserIn, _: str = Depends(require_admin)):
    sb = get_supabase_client()
    try:
        res = sb.auth.admin.create_user({
            "email": body.email.strip(),
            "password": body.password,
            "email_confirm": True,
        })
        uid = str(res.user.id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"No se pudo crear el usuario: {e}")

    plan = (body.plan or "").lower()
    mods = body.modules if body.modules is not None else PLANES.get(plan, [])
    _aplicar_modulos(uid, mods, None)
    if plan in PLANES:
        _upsert_sub(uid, {"plan": plan, "precio_mensual": PLAN_PRECIO.get(plan), "estado": "prueba"})
    return {"user_id": uid, "email": body.email}


@router.put("/users/{uid}/modules")
async def set_modules(uid: str, body: ModulesIn, _: str = Depends(require_admin)):
    _aplicar_modulos(uid, body.modules, body.valid_until)
    return {"ok": True}


@router.put("/users/{uid}/role")
async def set_role(uid: str, body: RoleIn, admin_id: str = Depends(require_super_admin)):
    """Asigna el rol de un usuario. 'admin'/'socio' lo registran en app_admins;
    'cliente' lo quita. Solo el administrador máximo puede hacerlo."""
    role = (body.role or "").strip().lower()
    if role not in ("admin", "socio", "cliente"):
        raise HTTPException(status_code=400, detail="Rol inválido (admin | socio | cliente)")
    sb = get_supabase_client()
    if uid == admin_id and role != "admin":
        raise HTTPException(status_code=400, detail="No puedes quitarte tu propio rol de administrador")
    if role == "cliente":
        sb.table("app_admins").delete().eq("user_id", uid).execute()
    else:
        existing = sb.table("app_admins").select("user_id").eq("user_id", uid).execute().data
        if existing:
            sb.table("app_admins").update({"role": role}).eq("user_id", uid).execute()
        else:
            sb.table("app_admins").insert({"user_id": uid, "role": role}).execute()
    # Mantener user_roles en un solo rol (compat: este endpoint asigna UN rol).
    sb.table("user_roles").delete().eq("user_id", uid).execute()
    sb.table("user_roles").insert({"user_id": uid, "role": role, "granted_by": admin_id}).execute()
    from routers.access import invalidar_cache_rol
    invalidar_cache_rol(uid)
    return {"ok": True, "role": role}


@router.put("/users/{uid}/roles")
async def set_roles(uid: str, body: RolesIn, admin_id: str = Depends(require_super_admin)):
    """Otorga el CONJUNTO de roles de un usuario (tabla user_roles), entre los
    que luego podrá cambiar con el selector. El rol ACTIVO (app_admins) se
    mantiene si sigue permitido; si no, baja/sube al de mayor privilegio del
    conjunto. Solo el administrador máximo puede otorgar roles."""
    validos = {"admin", "socio", "cliente"}
    pedidos = {(r or "").strip().lower() for r in (body.roles or [])} & validos
    if not pedidos:
        pedidos = {"cliente"}
    if uid == admin_id and "admin" not in pedidos:
        raise HTTPException(status_code=400, detail="No puedes quitarte tu propio rol de administrador")
    sb = get_supabase_client()

    # Sincronizar user_roles con el conjunto pedido
    actuales = {r["role"] for r in (sb.table("user_roles").select("role").eq("user_id", uid).execute().data or [])}
    for r in pedidos - actuales:
        sb.table("user_roles").insert({"user_id": uid, "role": r, "granted_by": admin_id}).execute()
    for r in actuales - pedidos:
        sb.table("user_roles").delete().eq("user_id", uid).eq("role", r).execute()

    # Rol ACTIVO: conservar el actual si sigue permitido; si no, el de mayor privilegio.
    ex = sb.table("app_admins").select("role").eq("user_id", uid).execute().data
    activo_actual = (ex[0].get("role") if ex else None) or ("socio" if ex else "cliente")
    if activo_actual not in pedidos:
        activo = sorted(pedidos, key=lambda r: _ROL_ORDEN.get(r, 9))[0]
        if activo == "cliente":
            sb.table("app_admins").delete().eq("user_id", uid).execute()
        elif ex:
            sb.table("app_admins").update({"role": activo}).eq("user_id", uid).execute()
        else:
            sb.table("app_admins").insert({"user_id": uid, "role": activo}).execute()

    from routers.access import invalidar_cache_rol
    invalidar_cache_rol(uid)
    try:
        from tenancy import invalidate_clients_cache
        invalidate_clients_cache(uid)
    except Exception:
        pass
    return {"ok": True, "roles": sorted(pedidos, key=lambda r: _ROL_ORDEN.get(r, 9))}


class SubmodulesIn(BaseModel):
    submodules: List[str]   # lista plana de submódulos PERMITIDOS (estado completo)


@router.get("/submodulos-catalogo")
async def submodulos_catalogo(_: str = Depends(require_admin)):
    """Catálogo de submódulos por módulo (para las casillas del panel)."""
    return {"catalogo": SUBMODULOS}


@router.put("/users/{uid}/submodules")
async def set_submodules(uid: str, body: SubmodulesIn, _: str = Depends(require_admin)):
    """Restringe a un usuario a un SUBCONJUNTO de pantallas dentro de cada módulo.
    Recibe la lista COMPLETA de submódulos permitidos. Regla: por cada módulo, si
    están TODOS marcados no se guarda restricción (= todo permitido, default); si
    hay algunos desmarcados se guarda el subconjunto permitido. Para negar TODAS
    las pantallas de un módulo, quita el módulo (no desmarques todo)."""
    pedido = set(body.submodules or [])
    filas = set()
    for mod, keys in _SUBS_KEYS.items():
        permitidos_mod = pedido & keys
        if permitidos_mod and permitidos_mod != keys:
            filas |= permitidos_mod   # restricción real: guardar el subconjunto
        # permitidos_mod == keys  → sin restricción (no se guardan filas)
        # permitidos_mod vacío     → sin filas = todo (para negar todo, quitar el módulo)
    sb = get_supabase_client()
    sb.table("user_submodules").delete().eq("user_id", uid).execute()
    for s in filas:
        sb.table("user_submodules").insert({"user_id": uid, "submodulo": s}).execute()
    invalidar_cache_rol(uid)
    return {"ok": True, "restringidos": sorted(filas)}


@router.post("/users/{uid}/plan")
async def set_plan(uid: str, body: PlanIn, _: str = Depends(require_admin)):
    plan = body.plan.lower()
    mods = PLANES.get(plan)
    if mods is None:
        raise HTTPException(status_code=400, detail="Plan inválido")
    _aplicar_modulos(uid, mods, body.valid_until)
    _upsert_sub(uid, {"plan": plan, "precio_mensual": PLAN_PRECIO.get(plan)})
    return {"ok": True, "modules": mods}


# ---------------------------------------------------------------------------
# Gestión de acceso a clientes — admin asigna qué contribuyentes ve cada usuario
# ---------------------------------------------------------------------------

@router.get("/client-access")
async def listar_acceso_clientes(uid: str = Query(...), _: str = Depends(require_admin)):
    """Devuelve todos los contribuyentes agrupados por identificacion (RUC/cédula),
    sin duplicados aunque el mismo RUC exista en varios propietarios."""
    from database import fetch_all
    sb = get_supabase_client()
    todos = fetch_all(lambda: sb.table("clients").select("id,identificacion,nombre"))
    access = sb.table("client_access").select("client_id").eq("granted_to", uid).execute().data or []
    granted_ids = {r["client_id"] for r in access}

    grupos: dict = {}
    for c in todos:
        ident = c["identificacion"]
        g = grupos.setdefault(ident, {
            "identificacion": ident,
            "nombre": c["nombre"] or ident,
            "client_ids": [],
        })
        g["client_ids"].append(c["id"])
        # Usar el nombre más reciente/completo disponible
        if c.get("nombre") and len(c["nombre"]) > len(g["nombre"]):
            g["nombre"] = c["nombre"]

    result = []
    for g in grupos.values():
        ids = g["client_ids"]
        g["con_acceso"] = all(cid in granted_ids for cid in ids)
        g["parcial"] = any(cid in granted_ids for cid in ids) and not g["con_acceso"]
        result.append(g)

    result.sort(key=lambda x: (x.get("nombre") or "").upper())
    return {"data": result}


@router.put("/client-access")
async def set_acceso_cliente(body: ClientAccessIn, admin_id: str = Depends(require_admin)):
    """Otorga o revoca acceso a TODOS los períodos de un contribuyente (por RUC)
    para un usuario, sin importar quién los creó."""
    sb = get_supabase_client()
    clients = sb.table("clients").select("id").eq("identificacion", body.identificacion).execute().data or []
    ids = [c["id"] for c in clients]
    if not ids:
        raise HTTPException(status_code=404, detail="Contribuyente no encontrado")

    if body.grant:
        for cid in ids:
            sb.table("client_access").upsert({
                "client_id": cid,
                "granted_to": body.granted_to,
                "granted_by": admin_id,
            }, on_conflict="client_id,granted_to").execute()
    else:
        for cid in ids:
            sb.table("client_access").delete() \
                .eq("client_id", cid).eq("granted_to", body.granted_to).execute()

    return {"ok": True, "client_ids": ids, "grant": body.grant}
