"""Bitácora de movimientos (auditoría de actividad).

`registrar(...)` deja constancia de QUÉ hizo un usuario, con QUÉ contribuyente y
en QUÉ proceso (subir facturas, guardar declaraciones, crear clientes, etc.).
Se usa desde los routers tras una operación de escritura exitosa.

Diseño defensivo: NUNCA lanza. Si la auditoría falla, la operación principal
del usuario no se ve afectada (solo se imprime el error en logs).

Aviso al administrador:
  - En la app: el contador de "nuevos" se calcula contra activity_seen (ver admin.py).
  - Por correo: si SMTP está configurado y existe la variable ACTIVITY_NOTIFY_EMAIL,
    se manda un aviso al instante, en un hilo aparte (no frena la petición).
"""
import os
import threading
from database import get_supabase_client
from services.email_sender import enviar_correo, email_configurado

# Caché de emails de usuarios (rara vez cambian) — evita pegarle a auth en cada movimiento.
_email_cache: dict = {}


def _email_de(uid: str) -> str:
    if not uid:
        return ""
    if uid in _email_cache:
        return _email_cache[uid]
    email = ""
    try:
        res = get_supabase_client().auth.admin.get_user_by_id(uid)
        user = getattr(res, "user", None) or res
        email = getattr(user, "email", "") or ""
    except Exception as e:
        print(f"[activity] no se pudo resolver email de {uid}: {e}")
    _email_cache[uid] = email
    return email


def _datos_cliente(client_id: str):
    if not client_id:
        return None, None
    try:
        r = get_supabase_client().table("clients").select(
            "identificacion,nombre").eq("id", client_id).execute().data
        if r:
            return r[0].get("identificacion"), r[0].get("nombre")
    except Exception as e:
        print(f"[activity] no se pudo resolver cliente {client_id}: {e}")
    return None, None


def _es_administrador(uid: str) -> bool:
    """True si el actor es el administrador principal (rol 'admin').
    Sus acciones NO se notifican por correo (solo quedan en el sistema)."""
    try:
        from routers.access import es_super_admin
        return es_super_admin(uid)
    except Exception:
        return False


def _notificar_email(*, actor_email, action, entity, contribuyente, identificacion, cantidad):
    """Envía el aviso al administrador. Pensado para correr en un hilo aparte."""
    destino = (os.environ.get("ACTIVITY_NOTIFY_EMAIL") or "").strip()
    if not destino or not email_configurado():
        return
    # No avisar al admin de sus propias acciones (por si actor == destino).
    if actor_email and actor_email.strip().lower() == destino.lower():
        return
    quien = actor_email or "Un usuario"
    cant = f"{cantidad} " if cantidad else ""
    contrib = f" — {contribuyente}" if contribuyente else ""
    ruc = f" ({identificacion})" if identificacion else ""
    asunto = f"Movimiento nuevo: {entity}"
    cuerpo = (
        "Se registró un movimiento en el Gestor SRI:\n\n"
        f"  Usuario:       {quien}\n"
        f"  Proceso:       {entity}\n"
        f"  Acción:        {action}\n"
        f"  Cantidad:      {cant}elemento(s)\n"
        f"  Contribuyente: {(contribuyente or '—')}{ruc}\n\n"
        "Revisa el detalle en el módulo «Movimientos» de la app."
    )
    try:
        enviar_correo(destino, asunto, cuerpo)
    except Exception as e:
        print(f"[activity] fallo aviso email: {e}")


def registrar(*, actor_user_id, action, entity, module=None, client_id=None,
              identificacion=None, contribuyente=None, cantidad=None, metadata=None,
              notificar=True):
    """Registra un movimiento. Nunca lanza."""
    try:
        if client_id and (identificacion is None or contribuyente is None):
            ruc, nom = _datos_cliente(client_id)
            identificacion = identificacion or ruc
            contribuyente = contribuyente or nom
        actor_email = _email_de(actor_user_id)
        get_supabase_client().table("activity_log").insert({
            "actor_user_id": actor_user_id,
            "actor_email": actor_email,
            "action": action,
            "module": module,
            "entity": entity,
            "client_id": client_id,
            "identificacion": identificacion,
            "contribuyente": contribuyente,
            "cantidad": cantidad,
            "metadata": metadata,
        }).execute()
        # El correo se manda solo para acciones de socios/clientes, NO del admin.
        if notificar and not _es_administrador(actor_user_id):
            threading.Thread(
                target=_notificar_email,
                kwargs=dict(actor_email=actor_email, action=action, entity=entity,
                            contribuyente=contribuyente, identificacion=identificacion,
                            cantidad=cantidad),
                daemon=True,
            ).start()
    except Exception as e:
        print(f"[activity] no se pudo registrar movimiento ({entity}): {e}")
