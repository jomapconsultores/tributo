# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""MULTIEMPRESA — empresas (despachos) y sus miembros.

Aquí vive todo lo que se administra del modelo nuevo:
  · las EMPRESAS (crear, renombrar, suspender, eliminar),
  · sus MIEMBROS (qué usuario pertenece a cuál y con qué rol),
  · los PERMISOS de cada miembro DENTRO de esa empresa (módulos y pantallas),
  · a qué empresa pertenece cada contribuyente.

Quién puede qué
---------------
  · Administrador de PLATAFORMA (app_admins.role='admin'): todo, en cualquier
    empresa. Es quien vende el producto.
  · Administrador DE UNA EMPRESA (organization_members.role='admin'): gestiona
    los miembros y permisos de SU empresa, y nada más. No puede crear empresas
    ni darse módulos que la empresa no tenga.
El resto de roles solo puede consultar la lista de empresas a las que pertenece
(la necesita el selector de empresa del frontend).
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import orgs
from auth import get_current_user
from database import get_supabase_client, fetch_all
from routers.access import (MODULOS, SUBMODULOS, es_super_admin,
                            invalidar_cache_rol)

router = APIRouter(prefix="/api/organizations", tags=["organizations"])

_SUBS_KEYS = {mod: {s["key"] for s in subs} for mod, subs in SUBMODULOS.items()}
_ROLES = set(orgs.ROLES_ORG)


# ---------------------------------------------------------------------------
# Modelos de entrada
# ---------------------------------------------------------------------------

class OrgIn(BaseModel):
    nombre: str
    identificacion: Optional[str] = None


class OrgUpdate(BaseModel):
    nombre: Optional[str] = None
    identificacion: Optional[str] = None
    activa: Optional[bool] = None


class MemberIn(BaseModel):
    """Alta de miembro. Se identifica por email o por user_id (uno de los dos)."""
    email: Optional[str] = None
    user_id: Optional[str] = None
    role: str = "cliente"
    # None = entra SIN módulos, y el administrador le marca los que necesite.
    # Antes esto significaba «hereda los globales del usuario», y como las
    # cuentas se crean con un plan que los da todos, cualquiera entraba a una
    # empresa ajena viéndolo todo desde el primer día.
    modules: Optional[List[str]] = None
    submodules: Optional[List[str]] = None   # None = todas las pantallas de sus módulos


class MemberUpdate(BaseModel):
    """Actualización PARCIAL: lo que no venga NO se toca.

    Es distinto de MemberIn a propósito. Aquí `modules: None` significa «no
    cambies los módulos» —si significara «déjalo sin módulos propios», cambiar
    solo el rol borraría de paso todos los permisos del miembro—. Para dejarlo
    sin ningún módulo se manda la lista vacía, que sí es una decisión explícita."""
    role: Optional[str] = None
    modules: Optional[List[str]] = None
    submodules: Optional[List[str]] = None


class AsignarContribuyentesIn(BaseModel):
    """Mover contribuyentes a una empresa.

    `conservar_acceso` es lo mismo que ofrece la exportación: la empresa que
    los venía trabajando conserva la vista sobre ellos mediante una
    autorización revocable. Sin esto, sacar un contribuyente del despacho para
    que declare por su cuenta lo hacía desaparecer de la cartera de quien lo
    lleva, que es justo lo contrario de lo que se busca."""
    identificaciones: List[str]
    conservar_acceso: bool = True


class ExportarIn(BaseModel):
    """Convertir un contribuyente en EMPRESA propia.

    `conservar_acceso` decide qué pasa con el despacho que lo venía trabajando:
    con True se crea la autorización de vuelta (revocable en cualquier momento),
    con False el contribuyente se lleva sus datos y el despacho deja de verlo."""
    identificacion: str
    nombre: Optional[str] = None          # por defecto, el del contribuyente
    conservar_acceso: bool = True


class AutorizacionIn(BaseModel):
    """La empresa DUEÑA autoriza a otra a ver datos suyos."""
    grantee_org_id: str
    identificacion: Optional[str] = None  # None = toda la cartera
    nota: Optional[str] = None


# ---------------------------------------------------------------------------
# Guardas de permiso
# ---------------------------------------------------------------------------

def _sb():
    return get_supabase_client()


def _asegurar_tablas():
    if not orgs.hay_multiempresa():
        raise HTTPException(
            status_code=503,
            detail="El módulo de empresas todavía no está habilitado: falta aplicar la migración 051_organizations.sql",
        )


def _org_o_404(org_id: str) -> dict:
    r = _sb().table("organizations").select("*").eq("id", org_id).limit(1).execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Empresa no encontrada")
    return r[0]


def _puede_administrar(org_id: str, user_id: str) -> bool:
    """Administrador de plataforma, o administrador de ESA empresa."""
    return es_super_admin(user_id) or orgs.rol_en(user_id, org_id) == "admin"


def _exigir_admin_de_org(org_id: str, user_id: str):
    _asegurar_tablas()
    _org_o_404(org_id)
    if not _puede_administrar(org_id, user_id):
        raise HTTPException(status_code=403, detail="Solo un administrador de esta empresa")


async def require_plataforma(user_id: str = Depends(get_current_user)):
    """Crear y eliminar empresas es del administrador del producto, no de los
    administradores de cada despacho."""
    if not es_super_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo el administrador de la plataforma")
    return user_id


def _usuarios():
    """Usuarios de auth, como lista de dicts {user_id, email}."""
    try:
        res = _sb().auth.admin.list_users()
        users = res if isinstance(res, list) else getattr(res, "users", []) or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo listar usuarios: {e}")
    return [{"user_id": str(u.id), "email": u.email} for u in users]


# ---------------------------------------------------------------------------
# Empresas
# ---------------------------------------------------------------------------

@router.get("/")
async def mis_empresas(user_id: str = Depends(get_current_user)):
    """Empresas entre las que el usuario puede cambiar (alimenta el selector).

    Devuelve también cuál está activa AHORA, que es la que resolvió el
    middleware a partir de la cabecera X-Org-Id."""
    empresas = orgs.empresas_visibles(user_id, es_super_admin(user_id))
    activa = orgs.org_activa()
    return {
        "data": empresas,
        "activa": activa,
        "multiempresa": orgs.hay_multiempresa(),
        # Para que el frontend sepa si mostrar el menú de administración de empresas
        "puede_crear": es_super_admin(user_id),
    }


@router.post("/")
async def crear_empresa(body: OrgIn, admin_id: str = Depends(require_plataforma)):
    """Crea una empresa y deja a quien la crea como administrador de ella."""
    _asegurar_tablas()
    nombre = (body.nombre or "").strip()
    if not nombre:
        raise HTTPException(status_code=400, detail="El nombre de la empresa es obligatorio")
    sb = _sb()
    try:
        creada = sb.table("organizations").insert({
            "nombre": nombre,
            "identificacion": (body.identificacion or "").strip() or None,
            "created_by": admin_id,
        }).execute().data
    except Exception as e:
        from database import es_error_duplicado
        if es_error_duplicado(e):
            raise HTTPException(status_code=409, detail=f"Ya existe una empresa llamada «{nombre}»")
        raise HTTPException(status_code=400, detail=str(e))
    if not creada:
        raise HTTPException(status_code=400, detail="No se pudo crear la empresa")
    org = creada[0]
    sb.table("organization_members").insert({
        "org_id": org["id"], "user_id": admin_id, "role": "admin", "granted_by": admin_id,
    }).execute()
    orgs.invalidar()
    invalidar_cache_rol(admin_id)
    return org


@router.put("/{org_id}")
async def actualizar_empresa(org_id: str, body: OrgUpdate,
                             user_id: str = Depends(get_current_user)):
    """Renombra la empresa o la suspende. Suspenderla (activa=false) la saca del
    selector de todos sus miembros: nadie entra a sus datos hasta reactivarla."""
    _exigir_admin_de_org(org_id, user_id)
    datos = {}
    if body.nombre is not None:
        nombre = body.nombre.strip()
        if not nombre:
            raise HTTPException(status_code=400, detail="El nombre no puede quedar vacío")
        datos["nombre"] = nombre
    if body.identificacion is not None:
        datos["identificacion"] = body.identificacion.strip() or None
    if body.activa is not None:
        # Suspender una empresa es de plataforma: un admin de despacho no debería
        # poder dejar fuera a todo su propio equipo por error.
        if not es_super_admin(user_id):
            raise HTTPException(status_code=403, detail="Solo el administrador de la plataforma puede activar o suspender una empresa")
        datos["activa"] = bool(body.activa)
    if not datos:
        return {"ok": True, "sin_cambios": True}
    datos["updated_at"] = "now()"
    try:
        _sb().table("organizations").update(datos).eq("id", org_id).execute()
    except Exception as e:
        from database import es_error_duplicado
        if es_error_duplicado(e):
            raise HTTPException(status_code=409, detail="Ya existe otra empresa con ese nombre")
        raise HTTPException(status_code=400, detail=str(e))
    orgs.invalidar(org_id=org_id)
    invalidar_cache_rol()
    return {"ok": True}


@router.delete("/{org_id}")
async def eliminar_empresa(org_id: str, _: str = Depends(require_plataforma)):
    """Elimina una empresa VACÍA. Si todavía tiene contribuyentes se rechaza:
    borrarla en cascada se llevaría por delante facturas, declaraciones y
    anexos. Para vaciarla, reasigna sus contribuyentes a otra empresa."""
    _asegurar_tablas()
    _org_o_404(org_id)
    sb = _sb()
    quedan = sb.table("clients").select("id", count="exact").eq("org_id", org_id).limit(1).execute()
    if (quedan.count or 0) > 0:
        raise HTTPException(
            status_code=409,
            detail=f"La empresa todavía tiene {quedan.count} contribuyente(s). Reasígnalos antes de eliminarla.",
        )
    sb.table("organizations").delete().eq("id", org_id).execute()  # miembros y permisos van en cascada
    orgs.invalidar()
    invalidar_cache_rol()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Miembros y sus permisos
# ---------------------------------------------------------------------------

def _modulos_globales(uid: str) -> list:
    """Módulos que el usuario tiene por su cuenta (user_modules), que es lo que
    hereda una membresía sin permisos propios. Sin esto, la pantalla mostraba
    cero módulos marcados para alguien que los tenía TODOS."""
    from datetime import date
    try:
        filas = _sb().table("user_modules").select("modulo,activo,valid_until")            .eq("user_id", uid).eq("activo", True).execute().data or []
    except Exception:
        return []
    hoy = date.today().isoformat()
    return [f["modulo"] for f in filas
            if not (f.get("valid_until") and str(f["valid_until"]) < hoy)]


def _modulos_de_miembro(org_id: str, uid: str) -> dict:
    filas = _sb().table("organization_member_modules")\
        .select("modulo,activo,valid_until").eq("org_id", org_id).eq("user_id", uid)\
        .execute().data or []
    return {f["modulo"]: {"activo": bool(f.get("activo")), "valid_until": f.get("valid_until")}
            for f in filas}


def _submodulos_permitidos_de(guardados: set) -> set:
    """Lista PLANA de pantallas permitidas: por cada módulo, el subconjunto
    guardado, o TODAS si no hay ninguna fila (default = sin restricción)."""
    out = set()
    for mod, keys in _SUBS_KEYS.items():
        a = guardados & keys
        out |= (a if a else keys)
    return out


@router.get("/{org_id}/members")
async def listar_miembros(org_id: str, user_id: str = Depends(get_current_user)):
    """Miembros de la empresa con su rol, módulos y pantallas permitidas."""
    _exigir_admin_de_org(org_id, user_id)
    sb = _sb()
    filas = sb.table("organization_members").select("user_id,role,created_at")\
        .eq("org_id", org_id).execute().data or []
    emails = {u["user_id"]: u["email"] for u in _usuarios()}

    mods = sb.table("organization_member_modules")\
        .select("user_id,modulo,activo,valid_until").eq("org_id", org_id).execute().data or []
    por_usuario: dict = {}
    for m in mods:
        por_usuario.setdefault(m["user_id"], {})[m["modulo"]] = {
            "activo": bool(m.get("activo")), "valid_until": m.get("valid_until")}

    subs = sb.table("organization_member_submodules")\
        .select("user_id,submodulo").eq("org_id", org_id).execute().data or []
    subs_guardados: dict = {}
    for s in subs:
        subs_guardados.setdefault(s["user_id"], set()).add(s["submodulo"])

    out = []
    for f in filas:
        uid = f["user_id"]
        propios = por_usuario.get(uid, {})
        # Sin filas propias la membresía HEREDA los módulos globales del usuario.
        # Hay que decirlo: pintar todo desmarcado para quien entra y lo ve todo
        # es lo que hacía creer que a los clientes no se les podía quitar nada.
        hereda = not propios
        efectivos = (_modulos_globales(uid) if hereda
                     else [m for m, v in propios.items() if v.get("activo")])
        out.append({
            "user_id": uid,
            "email": emails.get(uid, "(usuario eliminado)"),
            "role": f.get("role") or "cliente",
            "modules": propios,
            "modules_efectivos": sorted(efectivos),
            "hereda_modulos": hereda,
            "submodules": sorted(_submodulos_permitidos_de(subs_guardados.get(uid, set()))),
            "created_at": str(f.get("created_at") or "")[:10],
        })
    out.sort(key=lambda x: (orgs.ORDEN_ROL.get(x["role"], 9), (x["email"] or "").upper()))
    return {"data": out, "catalogo_modulos": MODULOS, "catalogo_submodulos": SUBMODULOS}


@router.get("/{org_id}/candidatos")
async def candidatos(org_id: str, user_id: str = Depends(get_current_user)):
    """Usuarios que todavía NO son miembros de esta empresa, para el desplegable
    de 'agregar miembro'."""
    _exigir_admin_de_org(org_id, user_id)
    ya = {f["user_id"] for f in (_sb().table("organization_members").select("user_id")
                                 .eq("org_id", org_id).execute().data or [])}
    libres = [u for u in _usuarios() if u["user_id"] not in ya]
    libres.sort(key=lambda u: (u["email"] or "").upper())
    return {"data": libres}


def _aplicar_modulos(org_id: str, uid: str, modules: Optional[List[str]]):
    """Fija los módulos del miembro DENTRO de esta empresa.

    modules=None borra las filas → la membresía deja de tener permisos propios y
    el usuario vuelve a heredar sus módulos globales. Una lista (aunque esté
    vacía) sí es una decisión explícita y se guarda módulo por módulo."""
    sb = _sb()
    if modules is None:
        sb.table("organization_member_modules").delete()\
            .eq("org_id", org_id).eq("user_id", uid).execute()
        return
    activos = set(modules) & set(MODULOS)
    for m in MODULOS:
        datos = {"activo": m in activos}
        existente = sb.table("organization_member_modules").select("id")\
            .eq("org_id", org_id).eq("user_id", uid).eq("modulo", m).execute().data
        if existente:
            sb.table("organization_member_modules").update(datos).eq("id", existente[0]["id"]).execute()
        else:
            sb.table("organization_member_modules").insert(
                {"org_id": org_id, "user_id": uid, "modulo": m, **datos}).execute()


def _aplicar_submodulos(org_id: str, uid: str, submodules: Optional[List[str]]):
    """Guarda la restricción de pantallas. Igual que en el panel por usuario: si
    de un módulo están TODAS marcadas no se guarda nada (= sin restricción).

    Y si no queda NINGUNA marcada, el módulo se apaga. «Sin filas» significa
    «sin restricción» en este modelo, así que desmarcar hasta la última pantalla
    de un módulo se leía como no haber restringido nada y las devolvía todas:
    el administrador creía haber cerrado la puerta y la dejaba abierta de par en
    par. Un módulo sin ninguna pantalla accesible no es un módulo."""
    if submodules is None:
        return
    pedido = set(submodules)
    filas = set()
    apagar = []
    for mod, keys in _SUBS_KEYS.items():
        permitidos = pedido & keys
        if not permitidos:
            apagar.append(mod)
        elif permitidos != keys:
            filas |= permitidos
    if apagar:
        sb0 = _sb()
        for mod in apagar:
            # Solo los que estuvieran encendidos: los demás ya están apagados y
            # los heredados no se tocan (esta ruta no crea permisos propios).
            sb0.table("organization_member_modules").update({"activo": False})                .eq("org_id", org_id).eq("user_id", uid).eq("modulo", mod)                .eq("activo", True).execute()
    sb = _sb()
    sb.table("organization_member_submodules").delete()\
        .eq("org_id", org_id).eq("user_id", uid).execute()
    for s in filas:
        sb.table("organization_member_submodules").insert(
            {"org_id": org_id, "user_id": uid, "submodulo": s}).execute()


@router.post("/{org_id}/members")
async def agregar_miembro(org_id: str, body: MemberIn,
                          admin_id: str = Depends(get_current_user)):
    """Agrega un usuario existente a la empresa con un rol y sus permisos."""
    _exigir_admin_de_org(org_id, admin_id)
    role = (body.role or "cliente").strip().lower()
    if role not in _ROLES:
        raise HTTPException(status_code=400, detail="Rol inválido (admin | socio | trabajador | cliente)")

    uid = (body.user_id or "").strip()
    if not uid:
        correo = (body.email or "").strip().lower()
        if not correo:
            raise HTTPException(status_code=400, detail="Indica el correo o el user_id del usuario")
        encontrado = next((u for u in _usuarios() if (u["email"] or "").lower() == correo), None)
        if not encontrado:
            raise HTTPException(status_code=404, detail=f"No existe un usuario con el correo {correo}")
        uid = encontrado["user_id"]

    sb = _sb()
    if sb.table("organization_members").select("id").eq("org_id", org_id).eq("user_id", uid).execute().data:
        raise HTTPException(status_code=409, detail="Ese usuario ya es miembro de esta empresa")
    sb.table("organization_members").insert({
        "org_id": org_id, "user_id": uid, "role": role, "granted_by": admin_id,
    }).execute()
    # Lista vacía, no None: se guardan las filas en cero y la membresía queda
    # cerrada de verdad, en vez de caer a los módulos globales del usuario.
    _aplicar_modulos(org_id, uid, body.modules if body.modules is not None else [])
    _aplicar_submodulos(org_id, uid, body.submodules)
    orgs.invalidar(user_id=uid, org_id=org_id)
    invalidar_cache_rol(uid)
    return {"ok": True, "user_id": uid, "role": role}


@router.put("/{org_id}/members/{uid}")
async def actualizar_miembro(org_id: str, uid: str, body: MemberUpdate,
                             admin_id: str = Depends(get_current_user)):
    """Cambia el rol y/o los permisos de un miembro DENTRO de esta empresa."""
    _exigir_admin_de_org(org_id, admin_id)
    sb = _sb()
    actual = sb.table("organization_members").select("id,role")\
        .eq("org_id", org_id).eq("user_id", uid).execute().data
    if not actual:
        raise HTTPException(status_code=404, detail="Ese usuario no es miembro de esta empresa")

    if body.role is not None:
        role = body.role.strip().lower()
        if role not in _ROLES:
            raise HTTPException(status_code=400, detail="Rol inválido (admin | socio | trabajador | cliente)")
        # No dejar la empresa sin ningún administrador: sin admin, nadie podría
        # volver a repartir permisos dentro de ella.
        if actual[0].get("role") == "admin" and role != "admin" and _cuenta_admins(org_id) <= 1:
            raise HTTPException(status_code=400, detail="La empresa quedaría sin administrador. Nombra otro antes de cambiar este rol.")
        sb.table("organization_members").update({"role": role, "updated_at": "now()"})\
            .eq("id", actual[0]["id"]).execute()

    # Solo se tocan los permisos que vengan en el cuerpo (ver MemberUpdate).
    if body.modules is not None:
        _aplicar_modulos(org_id, uid, body.modules)
    _aplicar_submodulos(org_id, uid, body.submodules)
    orgs.invalidar(user_id=uid, org_id=org_id)
    invalidar_cache_rol(uid)
    from tenancy import invalidate_clients_cache
    invalidate_clients_cache(uid)
    return {"ok": True}


def _cuenta_admins(org_id: str) -> int:
    r = _sb().table("organization_members").select("id", count="exact")\
        .eq("org_id", org_id).eq("role", "admin").execute()
    return r.count or 0


@router.delete("/{org_id}/members/{uid}")
async def quitar_miembro(org_id: str, uid: str, admin_id: str = Depends(get_current_user)):
    """Saca a un usuario de la empresa. No borra nada de lo que haya registrado:
    sus contribuyentes y datos siguen en la empresa, solo deja de verlos."""
    _exigir_admin_de_org(org_id, admin_id)
    sb = _sb()
    actual = sb.table("organization_members").select("role")\
        .eq("org_id", org_id).eq("user_id", uid).execute().data
    if not actual:
        raise HTTPException(status_code=404, detail="Ese usuario no es miembro de esta empresa")
    if actual[0].get("role") == "admin" and _cuenta_admins(org_id) <= 1:
        raise HTTPException(status_code=400, detail="Es el único administrador de la empresa. Nombra otro antes de quitarlo.")
    for tabla in ("organization_member_modules", "organization_member_submodules", "organization_members"):
        sb.table(tabla).delete().eq("org_id", org_id).eq("user_id", uid).execute()
    orgs.invalidar(user_id=uid, org_id=org_id)
    invalidar_cache_rol(uid)
    from tenancy import invalidate_clients_cache
    invalidate_clients_cache(uid)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Contribuyentes de la empresa
# ---------------------------------------------------------------------------

@router.get("/sin-empresa/contribuyentes")
async def contribuyentes_huerfanos(_: str = Depends(require_plataforma)):
    """Contribuyentes que quedaron sin empresa (org_id nulo). Solo deberían
    aparecer si algo se creó antes de aplicar la migración; se listan aquí para
    poder asignarlos en vez de que queden invisibles.

    OJO con el orden: esta ruta literal debe declararse ANTES que
    `/{org_id}/contribuyentes`, o FastAPI tomaría 'sin-empresa' como un org_id."""
    _asegurar_tablas()
    sb = _sb()
    filas = fetch_all(lambda: sb.table("clients").select("identificacion,nombre").is_("org_id", "null"))
    grupos: dict = {}
    for c in filas:
        g = grupos.setdefault(c["identificacion"], {"identificacion": c["identificacion"],
                                                    "nombre": c.get("nombre") or c["identificacion"],
                                                    "periodos": 0})
        g["periodos"] += 1
    return {"data": sorted(grupos.values(), key=lambda x: (x["nombre"] or "").upper())}


@router.get("/{org_id}/contribuyentes")
async def contribuyentes_de_empresa(org_id: str, user_id: str = Depends(get_current_user)):
    """Contribuyentes asignados a la empresa, agrupados por identificación."""
    _exigir_admin_de_org(org_id, user_id)
    sb = _sb()
    filas = fetch_all(lambda: sb.table("clients").select("identificacion,nombre").eq("org_id", org_id))
    grupos: dict = {}
    for c in filas:
        g = grupos.setdefault(c["identificacion"], {"identificacion": c["identificacion"],
                                                    "nombre": c.get("nombre") or c["identificacion"],
                                                    "periodos": 0})
        g["periodos"] += 1
        if c.get("nombre") and len(c["nombre"]) > len(g["nombre"]):
            g["nombre"] = c["nombre"]
    out = sorted(grupos.values(), key=lambda x: (x["nombre"] or "").upper())
    return {"data": out}


# ---------------------------------------------------------------------------
# Exportar un contribuyente a EMPRESA propia
# ---------------------------------------------------------------------------

@router.post("/exportar-contribuyente")
async def exportar_contribuyente(body: ExportarIn, admin_id: str = Depends(require_plataforma)):
    """Convierte un contribuyente en una empresa con su propia cartera.

    Sirve para cuando el cliente necesita entrar a ver lo suyo: se le crea la
    empresa, se le mueven TODOS los períodos de ese RUC —con sus facturas,
    declaraciones y anexos, que cuelgan del contribuyente y viajan con él— y se
    deja al administrador como miembro para que pueda dar de alta a su gente.

    Por defecto se crea la autorización de vuelta hacia la empresa de origen: si
    no, el despacho que lo venía trabajando dejaría de verlo de un momento a
    otro. Esa autorización es revocable y se puede afinar después."""
    _asegurar_tablas()
    ident = (body.identificacion or "").strip()
    if not ident:
        raise HTTPException(status_code=400, detail="Indica la identificación del contribuyente")

    sb = _sb()
    filas = sb.table("clients").select("id,nombre,org_id").eq("identificacion", ident).execute().data or []
    if not filas:
        raise HTTPException(status_code=404, detail=f"No hay ningún contribuyente con la identificación {ident}")

    origen = next((f["org_id"] for f in filas if f.get("org_id")), None)
    nombre = (body.nombre or "").strip() or max(
        (f.get("nombre") or "" for f in filas), key=len, default=ident) or ident

    # Si ya hay una empresa para ese RUC —lo normal es haberla creado a mano
    # antes de caer en la cuenta de que esto lo hace todo junto— se usa ESA. Dos
    # empresas para el mismo contribuyente no significan nada y parten sus datos.
    existente = sb.table("organizations").select("*").eq("identificacion", ident).limit(1).execute().data
    reutilizada = bool(existente)
    if reutilizada:
        nueva = existente[0]
    else:
        try:
            creada = sb.table("organizations").insert({
                "nombre": nombre, "identificacion": ident, "created_by": admin_id,
            }).execute().data
        except Exception as e:
            from database import es_error_duplicado
            if es_error_duplicado(e):
                raise HTTPException(status_code=409, detail=f"Ya existe una empresa llamada «{nombre}»")
            raise HTTPException(status_code=400, detail=str(e))
        nueva = creada[0]

    if origen == nueva["id"]:
        raise HTTPException(status_code=409,
                            detail=f"{ident} ya pertenece a la empresa «{nueva['nombre']}»")

    ya_miembro = sb.table("organization_members").select("id")        .eq("org_id", nueva["id"]).eq("user_id", admin_id).limit(1).execute().data
    if not ya_miembro:
        sb.table("organization_members").insert({
            "org_id": nueva["id"], "user_id": admin_id, "role": "admin", "granted_by": admin_id,
        }).execute()

    # Los períodos se mueven por identificación: un contribuyente es el RUC, y
    # sus períodos son filas del mismo. Mover solo uno lo partiría en dos empresas.
    sb.table("clients").update({"org_id": nueva["id"]}).eq("identificacion", ident).execute()

    autorizacion = None
    if body.conservar_acceso and origen and origen != nueva["id"]:
        sb.table("organization_grants").insert({
            "owner_org_id": nueva["id"], "grantee_org_id": origen,
            "identificacion": ident, "granted_by": admin_id,
            "nota": "Creada al exportar el contribuyente a empresa propia",
        }).execute()
        autorizacion = {"hacia": origen, "identificacion": ident}

    from tenancy import invalidate_clients_cache
    invalidate_clients_cache()
    orgs.invalidar()
    invalidar_cache_rol()
    return {"ok": True, "org_id": nueva["id"], "nombre": nueva["nombre"],
            "periodos_movidos": len(filas), "origen": origen,
            "reutilizada": reutilizada,
            "autorizacion_de_vuelta": autorizacion}


# ---------------------------------------------------------------------------
# Autorizaciones entre empresas
# ---------------------------------------------------------------------------

@router.get("/{org_id}/autorizaciones")
async def listar_autorizaciones(org_id: str, user_id: str = Depends(get_current_user)):
    """Las que esta empresa OTORGA (sobre sus datos) y las que RECIBE."""
    _exigir_admin_de_org(org_id, user_id)
    sb = _sb()
    todas = sb.table("organizations").select("id,nombre").execute().data or []
    nombre_de = {o["id"]: o["nombre"] for o in todas}

    def _pinta(filas, campo):
        return [{
            "id": f["id"],
            "org_id": f[campo],
            "empresa": nombre_de.get(f[campo], "(empresa eliminada)"),
            "identificacion": f.get("identificacion"),
            "alcance": "Toda la cartera" if not f.get("identificacion") else f["identificacion"],
            "nota": f.get("nota"),
        } for f in filas]

    otorgadas = sb.table("organization_grants").select("id,grantee_org_id,identificacion,nota")\
        .eq("owner_org_id", org_id).execute().data or []
    recibidas = sb.table("organization_grants").select("id,owner_org_id,identificacion,nota")\
        .eq("grantee_org_id", org_id).execute().data or []
    return {"otorgadas": _pinta(otorgadas, "grantee_org_id"),
            "recibidas": _pinta(recibidas, "owner_org_id"),
            "empresas": [o for o in todas if o["id"] != org_id]}


@router.post("/{org_id}/autorizaciones")
async def crear_autorizacion(org_id: str, body: AutorizacionIn,
                             admin_id: str = Depends(get_current_user)):
    """La empresa DUEÑA (org_id) autoriza a otra a ver datos suyos.

    Lo decide quien administra la empresa dueña: es su información. Autorizar
    'toda la cartera' es un cheque en blanco sobre todo lo que tenga y llegue a
    tener, así que lo normal es hacerlo por RUC."""
    _exigir_admin_de_org(org_id, admin_id)
    destino = (body.grantee_org_id or "").strip()
    if destino == org_id:
        raise HTTPException(status_code=400, detail="Una empresa no necesita autorizarse a sí misma")
    _org_o_404(destino)
    ident = (body.identificacion or "").strip() or None
    if ident:
        hay = _sb().table("clients").select("id").eq("identificacion", ident)\
            .eq("org_id", org_id).limit(1).execute().data
        if not hay:
            raise HTTPException(status_code=404, detail=f"{ident} no pertenece a esta empresa")
    try:
        _sb().table("organization_grants").insert({
            "owner_org_id": org_id, "grantee_org_id": destino,
            "identificacion": ident, "nota": (body.nota or "").strip() or None,
            "granted_by": admin_id,
        }).execute()
    except Exception as e:
        from database import es_error_duplicado
        if es_error_duplicado(e):
            raise HTTPException(status_code=409, detail="Esa autorización ya existe")
        raise HTTPException(status_code=400, detail=str(e))
    from tenancy import invalidate_clients_cache
    invalidate_clients_cache()
    orgs.invalidar()
    return {"ok": True}


@router.delete("/{org_id}/autorizaciones/{grant_id}")
async def revocar_autorizacion(org_id: str, grant_id: str,
                               admin_id: str = Depends(get_current_user)):
    """Revoca una autorización. Solo puede hacerlo la empresa DUEÑA: la que
    recibe el acceso no debe poder quitárselo a sí misma ni, sobre todo,
    conservarlo en contra de quien se lo dio."""
    _exigir_admin_de_org(org_id, admin_id)
    sb = _sb()
    fila = sb.table("organization_grants").select("id,owner_org_id")\
        .eq("id", grant_id).limit(1).execute().data
    if not fila:
        raise HTTPException(status_code=404, detail="Autorización no encontrada")
    if fila[0]["owner_org_id"] != org_id:
        raise HTTPException(status_code=403, detail="Solo la empresa dueña de los datos puede revocarla")
    sb.table("organization_grants").delete().eq("id", grant_id).execute()
    from tenancy import invalidate_clients_cache
    invalidate_clients_cache()
    orgs.invalidar()
    return {"ok": True}


@router.put("/{org_id}/contribuyentes")
async def asignar_contribuyentes(org_id: str, body: AsignarContribuyentesIn,
                                 admin_id: str = Depends(require_plataforma)):
    """Mueve contribuyentes (todos sus períodos, por identificación) a esta
    empresa. Es la herramienta para repartir la cartera cuando se separa la
    empresa por defecto en varias, y para rescatar huérfanos."""
    _asegurar_tablas()
    _org_o_404(org_id)
    idents = [i.strip() for i in (body.identificaciones or []) if (i or "").strip()]
    if not idents:
        return {"ok": True, "movidos": 0}
    sb = _sb()
    autorizaciones = []
    for ident in idents:
        # De dónde viene, ANTES de moverlo: después el dato ya no existe y no
        # habría a quién devolverle el acceso.
        filas = sb.table("clients").select("org_id").eq("identificacion", ident).execute().data or []
        origen = next((f["org_id"] for f in filas if f.get("org_id") and f["org_id"] != org_id), None)
        sb.table("clients").update({"org_id": org_id}).eq("identificacion", ident).execute()
        if body.conservar_acceso and origen:
            try:
                sb.table("organization_grants").insert({
                    "owner_org_id": org_id, "grantee_org_id": origen,
                    "identificacion": ident, "granted_by": admin_id,
                    "nota": "Creada al anexar el contribuyente a esta empresa",
                }).execute()
                autorizaciones.append({"hacia": origen, "identificacion": ident})
            except Exception as e:
                # Ya existía: el acceso está donde tiene que estar, nada que hacer.
                from database import es_error_duplicado
                if not es_error_duplicado(e):
                    raise
    from tenancy import invalidate_clients_cache
    invalidate_clients_cache()
    orgs.invalidar()
    return {"ok": True, "movidos": len(idents), "autorizaciones": autorizaciones}
