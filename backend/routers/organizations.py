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
    modules: Optional[List[str]] = None      # None = sin módulos propios (hereda los globales)
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
    identificaciones: List[str]


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
        out.append({
            "user_id": uid,
            "email": emails.get(uid, "(usuario eliminado)"),
            "role": f.get("role") or "cliente",
            "modules": por_usuario.get(uid, {}),
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
    de un módulo están TODAS marcadas no se guarda nada (= sin restricción)."""
    if submodules is None:
        return
    pedido = set(submodules)
    filas = set()
    for mod, keys in _SUBS_KEYS.items():
        permitidos = pedido & keys
        if permitidos and permitidos != keys:
            filas |= permitidos
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
    _aplicar_modulos(org_id, uid, body.modules)
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


@router.put("/{org_id}/contribuyentes")
async def asignar_contribuyentes(org_id: str, body: AsignarContribuyentesIn,
                                 _: str = Depends(require_plataforma)):
    """Mueve contribuyentes (todos sus períodos, por identificación) a esta
    empresa. Es la herramienta para repartir la cartera cuando se separa la
    empresa por defecto en varias, y para rescatar huérfanos."""
    _asegurar_tablas()
    _org_o_404(org_id)
    idents = [i.strip() for i in (body.identificaciones or []) if (i or "").strip()]
    if not idents:
        return {"ok": True, "movidos": 0}
    sb = _sb()
    for ident in idents:
        sb.table("clients").update({"org_id": org_id}).eq("identificacion", ident).execute()
    from tenancy import invalidate_clients_cache
    invalidate_clients_cache()
    orgs.invalidar()
    return {"ok": True, "movidos": len(idents)}
