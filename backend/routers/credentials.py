"""Gestión segura de credenciales de servicios externos (portal SRI, IESS, etc.).

Solo accesible por administradores (tabla app_admins). Cada acción queda registrada en
credential_access_log con admin_user_id, IP y user_agent. Las contraseñas se descifran solo
en el endpoint /reveal y nunca se devuelven en /list.
"""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from database import get_supabase_client, fetch_all, fetch_in, es_error_duplicado
from routers.admin import require_admin
from auth import get_current_user
from routers.access import es_admin, es_data_admin, rol_de
from tenancy import assert_client_owner, visible_client_ids
from services.credentials_crypto import encrypt, decrypt, can_decrypt

# Roles que pueden MARCAR qué declaraciones hace cada contribuyente (sin ver claves).
ROLES_MARCADO = {"admin", "socio", "trabajador"}

router = APIRouter(prefix="/api/credentials", tags=["credentials"])


def _autorizar_ver_credencial(user_id: str, client_id: str):
    """Autoriza VER/REVELAR la clave SRI de un contribuyente:
      - admin (data_admin): cualquier credencial, sin restricción de dueño.
      - socio: solo la de contribuyentes que puede ver (assert_client_owner).
      - cliente: no autorizado.
    Devuelve el rol efectivo ('admin' | 'socio') o lanza 403/404."""
    if es_data_admin(user_id):
        return "admin"
    if es_admin(user_id):  # socio
        assert_client_owner(client_id, user_id)  # 404 si no puede acceder
        return "socio"
    raise HTTPException(status_code=403, detail="Solo administrador o socio pueden ver las claves SRI")

SERVICIOS = {"sri_portal"}

# Servicios contratables que el admin puede marcar por cliente
CLIENT_SERVICES = {"declaracion_iva", "declaracion_ice", "declaracion_renta", "devolucion_iva"}


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
async def listar(req: Request, admin_id: str = Depends(require_admin), q: Optional[str] = None):
    """Listado con metadata + join a clients + servicios contratados.
    NO devuelve contraseñas (solo metadata + lista de servicios activos por cliente)."""
    sb = get_supabase_client()
    creds = sb.table("service_credentials").select(
        "id, client_id, service, username, key_version, ciphertext, notes, created_at, updated_at"
    ).order("updated_at", desc=True).execute().data or []
    if not creds:
        _log(credential_id=None, admin_user_id=admin_id, action="list", req=req, metadata={"count": 0, "q": q})
        return {"data": []}

    client_ids = list({c["client_id"] for c in creds})
    clients = sb.table("clients").select("id, identificacion, nombre").in_("id", client_ids).execute().data or []
    by_id = {c["id"]: c for c in clients}

    # Servicios contratados COMPARTIDOS POR RUC: un servicio marcado en cualquier
    # período del contribuyente vale para TODO el contribuyente (todos sus
    # períodos/módulos). Se calcula para TODOS los contribuyentes —no solo los que
    # ya tienen credencial— para que un cliente nuevo (sin clave) también muestre
    # y permita marcar sus servicios.
    todos = fetch_all(lambda: sb.table("clients").select("id, identificacion"))
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
    return {"data": out, "services_by_ruc": {k: sorted(v) for k, v in services_by_ruc.items()}}


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
    hermanos = sb.table("clients").select("id").eq("identificacion", ident).execute().data if ident else None
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
async def revelar_todos(req: Request, admin_id: str = Depends(require_admin)):
    """Descifra todas las credenciales sri_portal en una sola llamada.
    Auditado como un único evento 'reveal_all'. Solo admin."""
    sb = get_supabase_client()
    rows = sb.table("service_credentials").select(
        "id, client_id, service, username, ciphertext, key_version"
    ).eq("service", "sri_portal").execute().data or []

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
        # Damos un mensaje accionable (409) en vez de un error técnico.
        raise HTTPException(
            status_code=409,
            detail="Esta credencial fue guardada con una llave anterior y no se puede descifrar. "
                   "Vuelve a ingresar la contraseña (botón Editar) para guardarla con la llave actual.",
        )
    _log(credential_id=cred_id, admin_user_id=admin_id, action="reveal", req=req, metadata={"rol": rol})
    return {"id": cred_id, "service": row["service"], "username": row.get("username"), "password": password}


@router.post("")
async def crear(body: CredentialIn, req: Request, admin_id: str = Depends(require_admin)):
    if body.service not in SERVICIOS:
        raise HTTPException(status_code=400, detail=f"Servicio inválido. Permitidos: {sorted(SERVICIOS)}")
    sb = get_supabase_client()
    cl = sb.table("clients").select("id").eq("id", body.client_id).execute().data
    if not cl:
        raise HTTPException(status_code=404, detail="Cliente no existe")
    ciphertext, kv = encrypt(body.password)
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
async def actualizar(cred_id: int, body: CredentialUpdate, req: Request, admin_id: str = Depends(require_admin)):
    sb = get_supabase_client()
    cur = sb.table("service_credentials").select("id").eq("id", cred_id).execute().data
    if not cur:
        raise HTTPException(status_code=404, detail="Credencial no encontrada")
    updates = {"updated_by": admin_id}
    if body.username is not None:
        updates["username"] = body.username
    if body.notes is not None:
        updates["notes"] = body.notes
    if body.password is not None:
        ciphertext, kv = encrypt(body.password)
        updates["ciphertext"] = ciphertext
        updates["key_version"] = kv
    sb.table("service_credentials").update(updates).eq("id", cred_id).execute()
    _log(credential_id=cred_id, admin_user_id=admin_id, action="update", req=req,
         metadata={"changed": list(updates.keys())})
    return {"ok": True}


@router.delete("/{cred_id}")
async def eliminar(cred_id: int, req: Request, admin_id: str = Depends(require_admin)):
    sb = get_supabase_client()
    cur = sb.table("service_credentials").select("id").eq("id", cred_id).execute().data
    if not cur:
        raise HTTPException(status_code=404, detail="Credencial no encontrada")
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
