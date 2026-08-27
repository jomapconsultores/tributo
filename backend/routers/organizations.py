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
import os
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import orgs
from auth import get_current_user
from database import get_supabase_client, fetch_all
from routers.access import (MODULOS, SUBMODULOS, es_super_admin,
                            invalidar_cache_rol)
from services.activity import _email_de

router = APIRouter(prefix="/api/organizations", tags=["organizations"])

_SUBS_KEYS = {mod: {s["key"] for s in subs} for mod, subs in SUBMODULOS.items()}
_ROLES = set(orgs.ROLES_ORG)


# ---------------------------------------------------------------------------
# Modelos de entrada
# ---------------------------------------------------------------------------

# Prueba gratis y precio de arranque de una empresa nueva. Se pactan al crearla
# y se cambian después desde su bloque de suscripción.
DIAS_PRUEBA = 5
PRECIO_BASE = 50.0
DIAS_MES = 30
IVA = 0.15

# Aviso previo: al cliente se le escribe tres días antes de que se le renueve el
# plan (o de que se le acabe la prueba), no el día del corte. El mismo número lo
# usa el letrero de la app, para que lo que se ve en pantalla y lo que llega por
# correo digan lo mismo.
DIAS_AVISO_RENOVACION = 3

# Quien vende el producto: recibe copia de cada aviso que sale hacia un cliente,
# y es la dirección a la que se le pide al cliente que conteste.
ADMIN_EMAIL = (os.environ.get("ADMIN_EMAIL") or "jomapconsultores@gmail.com").strip()


class OrgIn(BaseModel):
    nombre: str
    identificacion: Optional[str] = None
    precio_mensual: Optional[float] = None   # None = PRECIO_BASE
    dias_prueba: Optional[int] = None        # None = DIAS_PRUEBA
    iva_incluido: bool = False               # False = el precio es NETO, se le suma IVA


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


class SuscripcionIn(BaseModel):
    """Lo que se pacta con la empresa. Lo que no venga no se toca."""
    precio_mensual: Optional[float] = None
    estado: Optional[str] = None          # prueba | activo | suspendido
    proximo_pago: Optional[str] = None    # AAAA-MM-DD
    plan: Optional[str] = None
    iva_incluido: Optional[bool] = None


class PagoOrgIn(BaseModel):
    monto: float
    meses: int = 1
    metodo: Optional[str] = None
    nota: Optional[str] = None
    iva_incluido: Optional[bool] = None    # None = como esté pactado
    avanzar: bool = True


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
    suscripcion = _crear_suscripcion(org["id"], body.precio_mensual,
                                     body.dias_prueba, body.iva_incluido)
    orgs.invalidar()
    invalidar_cache_rol(admin_id)
    return {**org, "suscripcion": suscripcion}


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


def _hoy():
    from datetime import date
    return date.today()


def _crear_suscripcion(org_id: str, precio: Optional[float],
                       dias: Optional[int], iva_incluido: bool = False) -> dict:
    """Arranca la suscripción de una empresa recién creada: prueba gratis de
    unos días y, al vencer, el sistema deja de dejarla entrar hasta que pague.

    La fila cuelga de la EMPRESA y de nadie más (user_id nulo): su equipo entra
    y sale sin que lo contratado se mueva."""
    from datetime import timedelta
    d = DIAS_PRUEBA if dias is None else max(0, int(dias))
    fin = (_hoy() + timedelta(days=d)).isoformat()
    fila = {
        "org_id": org_id,
        "estado": "prueba",
        "inicio": _hoy().isoformat(),
        "proximo_pago": fin,
        "precio_mensual": PRECIO_BASE if precio is None else float(precio),
        "iva_incluido": bool(iva_incluido),
    }
    try:
        _sb().table("subscriptions").insert(fila).execute()
    except Exception as e:
        # Sin la migración 056 la fila exige un usuario: no se puede cobrar a la
        # empresa todavía, pero la empresa ya está creada y se dice por qué.
        raise HTTPException(
            status_code=503,
            detail=f"La empresa se creó, pero no se pudo registrar su suscripción "
                   f"(¿falta aplicar 056_suscripcion_por_empresa.sql?): {e}")
    return fila


def _suscripcion_de(org_id: str) -> dict:
    """Estado de cobro de la empresa, con lo que hace falta para avisar a tiempo."""
    r = _sb().table("subscriptions").select("*").eq("org_id", org_id).limit(1).execute().data
    if not r:
        return {"contratada": False}
    s = dict(r[0])
    hoy = _hoy().isoformat()
    vencida = bool(s.get("proximo_pago")) and str(s["proximo_pago"]) < hoy
    dias = None
    if s.get("proximo_pago"):
        from datetime import date as _d
        y, m, dd = map(int, str(s["proximo_pago"]).split("-"))
        dias = (_d(y, m, dd) - _hoy()).days
    precio = float(s.get("precio_mensual") or 0)
    s.update({
        "contratada": True,
        "vencida": vencida,
        "vigente": s.get("estado") != "suspendido" and not vencida,
        "dias_restantes": dias,
        "en_prueba": s.get("estado") == "prueba",
        # Lo que se cobra de verdad, para no hacer la cuenta en tres pantallas.
        "total_con_iva": round(precio if s.get("iva_incluido") else precio * (1 + IVA), 2),
    })
    return s


def _correos_a_avisar(s: dict) -> tuple:
    """A quién se le escribe por esta suscripción, y de qué se llama lo cobrado.

    Si la suscripción es de una EMPRESA, el aviso va a quien la administra —el
    que paga—; si es de una persona (las de antes de multiempresa), a ella."""
    if s.get("org_id"):
        org = _sb().table("organizations").select("nombre").eq("id", s["org_id"]).limit(1).execute().data
        nombre = (org[0]["nombre"] if org else None)
        correos = [e for e in (_email_de(u) for u in orgs.admins_de_org(s["org_id"])) if e]
        return sorted(set(correos)), nombre
    correo = _email_de(s.get("user_id")) if s.get("user_id") else ""
    return ([correo] if correo else []), None


def _texto_aviso(s: dict, nombre_org: Optional[str]) -> tuple:
    """Asunto y cuerpo del aviso previo. Dice la fecha, el plan y lo que se va a
    cobrar CON IVA: el cliente tiene que poder decidir sin hacer cuentas."""
    de = f" de {nombre_org}" if nombre_org else ""
    fecha = str(s.get("proximo_pago"))
    precio = float(s.get("precio_mensual") or 0)
    total = round(precio if s.get("iva_incluido") else precio * (1 + IVA), 2)
    # Sin precio pactado no se inventa uno ni se escribe un guión donde el
    # cliente espera una cifra: se dice que está por acordar y se le da con
    # quién. La fecha sigue siendo real, y el acceso se corta igual.
    valor = (f"${precio:,.2f}" + (" (IVA incluido)" if s.get("iva_incluido")
                                  else f" + IVA = ${total:,.2f}") + " al mes") if precio else None
    prueba = s.get("estado") == "prueba"
    asunto = (f"Tu prueba gratuita{de} termina el {fecha}" if prueba
              else f"Tu plan{de} se renueva el {fecha}")
    cuerpo = (
        ("La prueba gratuita" if prueba else "El plan") + f"{de} "
        + ("termina" if prueba else "se renueva") + f" el {fecha}, "
        f"dentro de {DIAS_AVISO_RENOVACION} días.\n\n"
        f"  Plan:  {s.get('plan') or 'completo'}\n"
        + (f"  Valor: {valor}\n\n" if valor else
           f"  Valor: por acordar con {ADMIN_EMAIL}\n\n")
        + ("Para seguir entrando al sistema hay que registrar el pago antes de esa fecha.\n"
           if prueba else
           "Si todo sigue igual, basta con hacer el pago antes de esa fecha.\n")
        + f"Si prefieres cambiar el plan o darlo de baja, este es el momento de decirlo: "
          f"escribe a {ADMIN_EMAIL} y lo conversamos.\n\n"
        "Gestor Tributario"
    )
    return asunto, cuerpo


@router.api_route("/recordatorio-renovacion", methods=["GET", "POST"])
async def recordatorio_renovacion(token: Optional[str] = None):
    """Avisa al cliente TRES DÍAS ANTES de que se le renueve el plan.

    Lo dispara el cron diario, sin sesión, con el mismo CRON_SECRET que el
    recordatorio de cobros. Se avisa de la prueba que termina igual que del mes
    que se renueva: en los dos casos lo que viene después es un pago.

    No repite: cada suscripción avisada queda marcada con el vencimiento para el
    que ya se escribió, así que un segundo pase del mismo día no molesta a
    nadie. Si no hay a quién escribirle, o el correo falla, NO se marca —para
    que el intento del día siguiente lo vuelva a coger."""
    import hmac
    import os
    from datetime import timedelta
    from services.email_sender import email_configurado, enviar_correo

    secreto = (os.environ.get("CRON_SECRET") or "").strip()
    if not secreto:
        raise HTTPException(status_code=503, detail="CRON_SECRET no configurado en el servidor")
    if not token or not hmac.compare_digest(token, secreto):
        raise HTTPException(status_code=401, detail="Token inválido")

    objetivo = (_hoy() + timedelta(days=DIAS_AVISO_RENOVACION)).isoformat()
    filas = _sb().table("subscriptions").select("*").eq("proximo_pago", objetivo).execute().data or []
    filas = [s for s in filas if (s.get("estado") or "activo") in ("prueba", "activo")]
    if not filas:
        return {"ok": True, "fecha": objetivo, "avisados": 0, "motivo": "Ninguna renovación ese día"}
    if not email_configurado():
        return {"ok": False, "fecha": objetivo, "pendientes": len(filas),
                "error": "SMTP no configurado en el servidor"}

    avisados, repetidos, sin_destino, errores = [], 0, [], []
    for s in filas:
        if str(s.get("aviso_renovacion") or "") == objetivo:
            repetidos += 1
            continue
        correos, nombre = _correos_a_avisar(s)
        if not correos:
            sin_destino.append(s.get("org_id") or s.get("user_id"))
            continue
        asunto, cuerpo = _texto_aviso(s, nombre)
        ok, err = enviar_correo(", ".join(correos), asunto, cuerpo, copia=ADMIN_EMAIL)
        if not ok:
            errores.append({"suscripcion": s.get("id"), "error": err})
            continue
        _sb().table("subscriptions").update({"aviso_renovacion": objetivo}).eq("id", s["id"]).execute()
        avisados.append({"empresa": nombre, "correos": correos})

    return {"ok": not errores, "fecha": objetivo, "avisados": len(avisados),
            "detalle": avisados, "ya_avisados": repetidos,
            "sin_destinatario": sin_destino, "errores": errores}


@router.get("/{org_id}/suscripcion")
async def ver_suscripcion(org_id: str, user_id: str = Depends(get_current_user)):
    """Lo que paga la empresa y hasta cuándo está cubierta."""
    _exigir_admin_de_org(org_id, user_id)
    return _suscripcion_de(org_id)


@router.put("/{org_id}/suscripcion")
async def fijar_suscripcion(org_id: str, body: SuscripcionIn,
                            _: str = Depends(require_plataforma)):
    """Pacta el precio, el estado o la fecha del próximo pago. Es de plataforma:
    quien vende el producto pone el precio, no el despacho que lo usa."""
    _asegurar_tablas()
    _org_o_404(org_id)
    datos = {k: v for k, v in body.dict().items() if v is not None}
    if not datos:
        return {"ok": True, "sin_cambios": True}
    if "estado" in datos and datos["estado"] not in ("prueba", "activo", "suspendido"):
        raise HTTPException(status_code=400, detail="Estado inválido (prueba | activo | suspendido)")
    datos["updated_at"] = "now()"
    sb = _sb()
    if sb.table("subscriptions").select("id").eq("org_id", org_id).limit(1).execute().data:
        sb.table("subscriptions").update(datos).eq("org_id", org_id).execute()
    else:
        datos["org_id"] = org_id
        datos.setdefault("inicio", _hoy().isoformat())
        sb.table("subscriptions").insert(datos).execute()
    invalidar_cache_rol()
    return {"ok": True, "suscripcion": _suscripcion_de(org_id)}


@router.post("/{org_id}/suscripcion/pago")
async def registrar_pago_org(org_id: str, body: PagoOrgIn,
                             admin_id: str = Depends(require_plataforma)):
    """Registra el pago de la empresa y corre la fecha del próximo.

    Si la fecha vigente ya pasó se cuenta desde hoy, no desde la vencida: el mes
    pagado empieza cuando se paga, no cuando debió pagarse."""
    from datetime import date as _d, timedelta
    _asegurar_tablas()
    _org_o_404(org_id)
    sb = _sb()
    actual = sb.table("subscriptions").select("*").eq("org_id", org_id).limit(1).execute().data
    if not actual:
        raise HTTPException(status_code=404, detail="Esta empresa todavía no tiene suscripción")
    meses = max(1, int(body.meses or 1))
    iva_incluido = actual[0].get("iva_incluido") if body.iva_incluido is None else body.iva_incluido
    monto = round(float(body.monto), 2)
    monto_final = monto if iva_incluido else round(monto * (1 + IVA), 2)
    sb.table("pagos").insert({
        "org_id": org_id, "monto": monto_final, "fecha": _hoy().isoformat(),
        "periodo": f"{meses} mes(es)", "metodo": body.metodo, "nota": body.nota,
    }).execute()

    datos = {"estado": "activo", "updated_at": "now()"}
    if body.avanzar:
        base = None
        if actual[0].get("proximo_pago"):
            try:
                y, m, dd = map(int, str(actual[0]["proximo_pago"]).split("-"))
                base = _d(y, m, dd)
            except ValueError:
                base = None
        if not base or base < _hoy():
            base = _hoy()
        datos["proximo_pago"] = (base + timedelta(days=DIAS_MES * meses)).isoformat()
    sb.table("subscriptions").update(datos).eq("org_id", org_id).execute()
    invalidar_cache_rol()
    return {"ok": True, "cobrado": monto_final, "suscripcion": _suscripcion_de(org_id)}


@router.get("/{org_id}/pagos")
async def pagos_de_empresa(org_id: str, user_id: str = Depends(get_current_user)):
    """Historial de lo cobrado a la empresa."""
    _exigir_admin_de_org(org_id, user_id)
    return {"data": _sb().table("pagos").select("*").eq("org_id", org_id)
            .order("fecha", desc=True).execute().data or []}


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
        # Nace igual que cualquier empresa: unos días de prueba y, al vencer,
        # a pagar. Si se reutilizó una que ya existía, conserva la suya.
        _crear_suscripcion(nueva["id"], None, None)

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
