# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Gestión segura de credenciales de servicios externos (portal SRI, IESS, etc.).

Accesible para el equipo del despacho —administrador, socio y funcionario— sobre los
contribuyentes de SU empresa; nunca de otra. Cada acción queda registrada en
credential_access_log con admin_user_id, IP y user_agent. Las contraseñas se descifran solo
en los endpoints /reveal y nunca se devuelven en /list.
"""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from database import get_supabase_client, fetch_all, fetch_in, es_error_duplicado
from routers.admin import require_admin
from auth import get_current_user
from routers.access import es_data_admin, es_super_admin, rol_de
from tenancy import assert_client_owner, visible_client_ids, filtro_org
import orgs
from services.credentials_crypto import encrypt, decrypt, can_decrypt, key_configured

# Roles que pueden MARCAR qué declaraciones hace cada contribuyente (sin ver claves).
ROLES_MARCADO = {"admin", "socio", "trabajador"}

# Roles que pueden VER y ACTUALIZAR las claves del portal del SRI: los del
# despacho. El funcionario entra acá porque es quien declara: mandarlo a pedirle
# la clave al socio cada vez no protege nada y frena el trabajo.
ROLES_CLAVES = {"admin", "socio", "trabajador"}

router = APIRouter(prefix="/api/credentials", tags=["credentials"])


async def require_claves(user_id: str = Depends(get_current_user)):
    """Deja pasar a quien puede trabajar con las claves del SRI."""
    if not (es_super_admin(user_id) or rol_de(user_id) in ROLES_CLAVES):
        raise HTTPException(status_code=403, detail="No autorizado para ver las claves del SRI")
    return user_id


def _clientes_de_la_empresa(user_id: str):
    """IDs de contribuyentes de la EMPRESA ACTIVA, o None si no hay frontera que
    aplicar (instalación de una sola empresa)."""
    if not orgs.org_activa():
        return None
    sb = get_supabase_client()
    return {c["id"] for c in fetch_all(lambda: filtro_org(sb.table("clients").select("id")))}


def _contribuyentes_de_la_empresa():
    """Todos los contribuyentes del despacho, para la pantalla de claves.

    No se usa la cartera del usuario (`clients` visible por rol) a propósito: la
    pantalla es el listado de claves del despacho y tiene que mostrar a TODOS,
    también los que no tienen credencial cargada todavía —esa fila es la que
    permite agregarla—. Ordenado por nombre y período descendente, que es lo que
    espera el front para quedarse con el período más reciente de cada RUC."""
    sb = get_supabase_client()
    filas = fetch_all(lambda: filtro_org(sb.table("clients").select(
        "id, identificacion, nombre, periodicidad, periodo_semestre, periodo_mes, periodo_anio")))
    filas.sort(key=lambda c: (
        (c.get("nombre") or "").lower(),
        -(c.get("periodo_anio") or 0),
        -(c.get("periodo_mes") or 0),
    ))
    return filas


def _autorizar_ver_credencial(user_id: str, client_id: str):
    """Autoriza VER/REVELAR/ACTUALIZAR la clave SRI de un contribuyente.

    El alcance es la EMPRESA, no la cartera: admin, socio y funcionario ven la
    clave de CUALQUIER contribuyente del despacho, no solo la de los que cargó
    cada uno. Es a propósito y es lo que pide el trabajo —el que atiende declara
    por el contribuyente que le toque ese día—; filtrar por cartera dejaba al
    funcionario con una pantalla vacía.

    Lo que no se toca es la frontera entre empresas: son las claves del portal
    del SRI, lo más sensible que guarda el sistema, y un despacho no puede ver
    las de otro. Devuelve el rol efectivo o lanza 403/404."""
    rol = "admin" if es_super_admin(user_id) else rol_de(user_id)
    if not (es_super_admin(user_id) or rol in ROLES_CLAVES):
        raise HTTPException(status_code=403, detail="No autorizado para ver las claves del SRI")
    sb = get_supabase_client()
    # 404 y no 403: no se revela que el contribuyente existe en otra empresa.
    if not filtro_org(sb.table("clients").select("id")).eq("id", client_id).execute().data:
        raise HTTPException(status_code=404, detail="Cliente no encontrado")
    return rol

SERVICIOS = {"sri_portal"}

# Servicios contratables que el admin puede marcar por cliente
CLIENT_SERVICES = {"declaracion_iva", "declaracion_ice", "declaracion_renta", "devolucion_iva"}



def _cifrar(password: str):
    """Cifra la contraseña diciendo QUÉ falta cuando no se puede.

    Sin esto, si al servidor le falta CREDENTIALS_MASTER_KEY el guardado
    revienta con una excepción cruda: el navegador recibe un 500 pelado y el
    usuario ve "Network Error", que manda a buscar el problema en la red cuando
    está en la configuración del servidor."""
    try:
        return encrypt(password)
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail="No se puede guardar la clave: el servidor no tiene configurada la llave de "
                   "cifrado (CREDENTIALS_MASTER_KEY). Avisale a quien administra el despliegue. "
                   f"[{e.__class__.__name__}]",
        )


def _client_ip(req: Request) -> str:
    fwd = req.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return req.client.host if req.client else ""


def _log(*, credential_id, admin_user_id: str, action: str, req: Request, metadata=None):
    sb = get_supabase_client()
    try:
        sb.table("credential_access_log").insert({
            "credential_id": credential_id,
            "admin_user_id": admin_user_id,
            "action": action,
            "ip": _client_ip(req),
            "user_agent": (req.headers.get("user-agent") or "")[:500],
            "metadata": metadata,
        }).execute()
    except Exception as e:
        print(f"[credentials] audit log fail: {e}")


class CredentialIn(BaseModel):
    client_id: str = Field(..., description="UUID de clients.id")
    service: str = "sri_portal"
    username: Optional[str] = None
    password: str = Field(..., min_length=1)
    notes: Optional[str] = None


class CredentialUpdate(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = Field(None, min_length=1)
    notes: Optional[str] = None


@router.get("")
async def listar(req: Request, admin_id: str = Depends(require_claves), q: Optional[str] = None):
    """Listado con metadata + join a clients + servicios contratados.
    NO devuelve contraseñas (solo metadata + lista de servicios activos por cliente)."""
    sb = get_supabase_client()
    creds = sb.table("service_credentials").select(
        "id, client_id, service, username, key_version, ciphertext, notes, created_at, updated_at"
    ).order("updated_at", desc=True).execute().data or []
    # La credencial vive colgada de un contribuyente: si el contribuyente es de
    # otra empresa, su clave no se lista acá por más rol que se tenga.
    de_la_empresa = _clientes_de_la_empresa(admin_id)
    if de_la_empresa is not None:
        creds = [c for c in creds if c.get("client_id") in de_la_empresa]
    if not creds:
        _log(credential_id=None, admin_user_id=admin_id, action="list", req=req, metadata={"count": 0, "q": q})
        # Con los contribuyentes igual: sin una fila por contribuyente no hay
        # dónde cargar la PRIMERA clave, y la pantalla quedaría vacía sin salida.
        return {"data": [], "services_by_ruc": {}, "llave_ok": key_configured(),
                "contribuyentes": _contribuyentes_de_la_empresa()}

    client_ids = list({c["client_id"] for c in creds})
    clients = sb.table("clients").select("id, identificacion, nombre").in_("id", client_ids).execute().data or []
    by_id = {c["id"]: c for c in clients}

    # Servicios contratados COMPARTIDOS POR RUC: un servicio marcado en cualquier
    # período del contribuyente vale para TODO el contribuyente (todos sus
    # períodos/módulos). Se calcula para TODOS los contribuyentes —no solo los que
    # ya tienen credencial— para que un cliente nuevo (sin clave) también muestre
    # y permita marcar sus servicios.
    todos = fetch_all(lambda: filtro_org(sb.table("clients").select("id, identificacion")))
    ruc_por_id = {}
    for r in todos:
        if r.get("identificacion"):
            ruc_por_id[r["id"]] = r["identificacion"]
    todos_ids = list(ruc_por_id.keys()) or client_ids
    services_rows = fetch_in(lambda: sb.table("client_services").select("client_id, service, active"), todos_ids, "client_id")
    services_by_ruc = {}
    for s in services_rows:
        if not s.get("active"):
            continue
        ruc = ruc_por_id.get(s["client_id"])
        if ruc:
            services_by_ruc.setdefault(ruc, set()).add(s["service"])

    out = []
    for c in creds:
        cl = by_id.get(c["client_id"], {})
        nombre = cl.get("nombre", "") or ""
        ruc = cl.get("identificacion", "") or ""
        if q:
            ql = q.lower().strip()
            if ql and ql not in nombre.lower() and ql not in ruc.lower():
                continue
        # ¿Se puede descifrar con la llave actual? Si no, la credencial fue
        # cifrada con una llave anterior y debe reingresarse (NO se expone el ciphertext).
        needs_reentry = not can_decrypt(c.get("ciphertext", ""), c["key_version"])
        out.append({
            "id": c["id"],
            "client_id": c["client_id"],
            "ruc": ruc,
            "nombre": nombre,
            "service": c["service"],
            "username": c.get("username"),
            "key_version": c["key_version"],
            "needs_reentry": needs_reentry,
            "notes": c.get("notes"),
            "created_at": c["created_at"],
            "updated_at": c["updated_at"],
            "client_services": sorted(services_by_ruc.get(ruc, set())),
        })
    _log(credential_id=None, admin_user_id=admin_id, action="list", req=req, metadata={"count": len(out), "q": q})
    # services_by_ruc para que el frontend pinte los servicios de TODOS los
    # contribuyentes (incl. los que aún no tienen credencial).
    return {
        "data": out,
        "services_by_ruc": {k: sorted(v) for k, v in services_by_ruc.items()},
        "contribuyentes": _contribuyentes_de_la_empresa(),
        # Sin llave de cifrado no se puede guardar NI revelar: que la pantalla lo
        # diga, en vez de dejar que cada intento muera con un error de red.
        "llave_ok": key_configured(),
    }


@router.put("/services/{client_id}/{service}")
async def toggle_servicio(
    client_id: str,
    service: str,
    req: Request,
    user_id: str = Depends(get_current_user),
):
    """Marca/desmarca qué declaración hace un contribuyente. Accesible a admin,
    socio y trabajador (funcionario). El admin no tiene restricción de dueño; el
    socio/trabajador solo sobre contribuyentes VISIBLES para su rol.
    Body opcional con {"active": true/false}; por defecto invierte el estado actual."""
    if service not in CLIENT_SERVICES:
        raise HTTPException(status_code=400, detail=f"Servicio inválido. Permitidos: {sorted(CLIENT_SERVICES)}")
    if rol_de(user_id) not in ROLES_MARCADO:
        raise HTTPException(status_code=403, detail="No autorizado para marcar declaraciones")
    admin_id = user_id
    data_admin = es_data_admin(user_id)
    if not data_admin:
        assert_client_owner(client_id, user_id)  # 404 si no puede acceder a este contribuyente
    sb = get_supabase_client()

    # Body opcional con estado deseado
    body = {}
    try:
        body = await req.json()
    except Exception:
        body = {}
    desired_active = body.get("active")

    # Verificar cliente existe y obtener su identificación
    cl = sb.table("clients").select("id, identificacion").eq("id", client_id).execute().data
    if not cl:
        raise HTTPException(status_code=404, detail="Cliente no existe")
    ident = cl[0].get("identificacion")

    # El servicio afecta a TODO el contribuyente: se aplica a TODOS sus períodos
    # (todos los client_id que comparten la identificación), no solo a uno.
    # …pero solo los períodos de la EMPRESA ACTIVA: el mismo RUC puede estar
    # registrado en otro despacho y marcar sus servicios no es cosa de este.
    hermanos = filtro_org(sb.table("clients").select("id").eq("identificacion", ident)).execute().data if ident else None
    ids = [h["id"] for h in (hermanos or [])] or [client_id]
    # Socio/trabajador: no tocar períodos que no le son visibles (aunque compartan RUC).
    if not data_admin:
        vis = visible_client_ids(user_id) or set()
        ids = [i for i in ids if i in vis] or [client_id]

    existing = sb.table("client_services").select("id, client_id, active").in_(
        "client_id", ids).eq("service", service).execute().data or []
    # Estado actual agregado: activo si CUALQUIER período lo tiene activo.
    cur_active = any(e.get("active") for e in existing)
    new_active = bool(desired_active) if desired_active is not None else (not cur_active)

    con_fila = {e["client_id"] for e in existing}
    for cid in ids:
        if cid in con_fila:
            sb.table("client_services").update({"active": new_active}).eq(
                "client_id", cid).eq("service", service).execute()
        else:
            sb.table("client_services").insert({
                "client_id": cid, "service": service,
                "active": new_active, "created_by": admin_id,
            }).execute()
    action = "service_toggle_on" if new_active else "service_toggle_off"

    _log(credential_id=None, admin_user_id=admin_id, action="update", req=req,
         metadata={"sub_action": action, "identificacion": ident, "periodos": len(ids),
                   "service": service, "active": new_active})
    return {"ok": True, "service": service, "active": new_active}


@router.get("/reveal-all")
async def revelar_todos(req: Request, admin_id: str = Depends(require_claves)):
    """Descifra todas las credenciales sri_portal de la empresa en una sola
    llamada. Auditado como un único evento 'reveal_all'."""
    sb = get_supabase_client()
    rows = sb.table("service_credentials").select(
        "id, client_id, service, username, ciphertext, key_version"
    ).eq("service", "sri_portal").execute().data or []
    de_la_empresa = _clientes_de_la_empresa(admin_id)
    if de_la_empresa is not None:
        rows = [r for r in rows if r.get("client_id") in de_la_empresa]

    out = []
    errors = []
    for row in rows:
        try:
            password = decrypt(row["ciphertext"], row["key_version"])
            out.append({
                "credential_id": row["id"],
                "client_id": row["client_id"],
                "username": row.get("username"),
                "password": password,
            })
        except Exception as e:
            errors.append({"credential_id": row["id"], "client_id": row["client_id"], "error": str(e)})

    _log(credential_id=None, admin_user_id=admin_id, action="reveal_all", req=req,
         metadata={"count": len(out), "errors": len(errors)})
    return {"data": out, "errors": errors}


@router.get("/{cred_id}/reveal")
async def revelar(cred_id: int, req: Request, user_id: str = Depends(get_current_user)):
    """Devuelve la contraseña en plano. Acción auditada.
    Admin: cualquier credencial. Socio: solo la de contribuyentes que puede ver."""
    sb = get_supabase_client()
    rows = sb.table("service_credentials").select("*").eq("id", cred_id).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="Credencial no encontrada")
    row = rows[0]
    rol = _autorizar_ver_credencial(user_id, row.get("client_id"))
    admin_id = user_id
    try:
        password = decrypt(row["ciphertext"], row["key_version"])
    except Exception as e:
        _log(credential_id=cred_id, admin_user_id=admin_id, action="reveal", req=req, metadata={"error": str(e), "rol": rol})
        # Caso típico: la credencial se cifró con una llave maestra anterior.
        # Damos un mensaje accionable (409) en vez de un error técnico, y se
        # distingue el caso grave —el servidor no tiene NINGUNA llave— del
        # corriente, porque la salida no es la misma: uno se arregla en el
        # entorno del servidor y el otro reingresando la contraseña.
        if not key_configured():
            raise HTTPException(
                status_code=503,
                detail="El servidor no tiene configurada la llave de cifrado "
                       "(CREDENTIALS_MASTER_KEY): no se puede descifrar ni guardar ninguna clave. "
                       "Es configuración del despliegue, no hace falta reingresar nada.",
            )
        raise HTTPException(
            status_code=409,
            detail="Esta credencial se guardó con una llave de cifrado distinta de la que tiene hoy "
                   "el servidor, así que no se puede descifrar. Dos salidas: agregar la llave "
                   "original al entorno del backend (CREDENTIALS_MASTER_KEY_V2) y vuelve a abrirse "
                   "sola, o volver a ingresar la contraseña acá (botón ✎).",
        )
    _log(credential_id=cred_id, admin_user_id=admin_id, action="reveal", req=req, metadata={"rol": rol})
    return {"id": cred_id, "service": row["service"], "username": row.get("username"), "password": password}


@router.post("")
async def crear(body: CredentialIn, req: Request, admin_id: str = Depends(require_claves)):
    if body.service not in SERVICIOS:
        raise HTTPException(status_code=400, detail=f"Servicio inválido. Permitidos: {sorted(SERVICIOS)}")
    # Mismo alcance que revelar: el contribuyente tiene que ser de la empresa.
    _autorizar_ver_credencial(admin_id, body.client_id)
    sb = get_supabase_client()
    ciphertext, kv = _cifrar(body.password)
    try:
        res = sb.table("service_credentials").insert({
            "client_id": body.client_id,
            "service": body.service,
            "username": body.username,
            "ciphertext": ciphertext,
            "key_version": kv,
            "notes": body.notes,
            "created_by": admin_id,
        }).execute()
    except Exception as e:
        if es_error_duplicado(e):
            raise HTTPException(status_code=409, detail="Ya existe una credencial para ese cliente+servicio")
        raise HTTPException(status_code=500, detail=str(e))
    new_id = res.data[0]["id"] if res.data else None
    _log(credential_id=new_id, admin_user_id=admin_id, action="create", req=req)
    return {"id": new_id, "ok": True}


@router.put("/{cred_id}")
async def actualizar(cred_id: int, body: CredentialUpdate, req: Request, admin_id: str = Depends(require_claves)):
    sb = get_supabase_client()
    cur = sb.table("service_credentials").select("id, client_id").eq("id", cred_id).execute().data
    if not cur:
        raise HTTPException(status_code=404, detail="Credencial no encontrada")
    _autorizar_ver_credencial(admin_id, cur[0].get("client_id"))
    updates = {"updated_by": admin_id}
    if body.username is not None:
        updates["username"] = body.username
    if body.notes is not None:
        updates["notes"] = body.notes
    if body.password is not None:
        ciphertext, kv = _cifrar(body.password)
        updates["ciphertext"] = ciphertext
        updates["key_version"] = kv
    sb.table("service_credentials").update(updates).eq("id", cred_id).execute()
    _log(credential_id=cred_id, admin_user_id=admin_id, action="update", req=req,
         metadata={"changed": list(updates.keys())})
    return {"ok": True}


@router.delete("/{cred_id}")
async def eliminar(cred_id: int, req: Request, admin_id: str = Depends(require_claves)):
    sb = get_supabase_client()
    cur = sb.table("service_credentials").select("id, client_id").eq("id", cred_id).execute().data
    if not cur:
        raise HTTPException(status_code=404, detail="Credencial no encontrada")
    _autorizar_ver_credencial(admin_id, cur[0].get("client_id"))
    sb.table("service_credentials").delete().eq("id", cred_id).execute()
    _log(credential_id=cred_id, admin_user_id=admin_id, action="delete", req=req)
    return {"ok": True}


@router.get("/audit-log")
async def auditoria(
    req: Request,
    admin_id: str = Depends(require_admin),
    limit: int = 100,
    credential_id: Optional[int] = None,
):
    """Historial de accesos (list/view/reveal/create/update/delete) a credenciales."""
    sb = get_supabase_client()
    q = sb.table("credential_access_log").select("*").order("occurred_at", desc=True).limit(min(max(limit, 1), 500))
    if credential_id is not None:
        q = q.eq("credential_id", credential_id)
    rows = q.execute().data or []
    return {"data": rows}
