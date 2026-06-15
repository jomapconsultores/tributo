"""Bitácora de movimientos (auditoría de actividad).

`registrar(...)` deja constancia de QUÉ hizo un usuario, con QUÉ contribuyente y
en QUÉ proceso (subir facturas, guardar declaraciones, crear clientes, etc.).
Se usa desde los routers tras una operación de escritura exitosa.

La bitácora es SOLO en la app: el administrador la revisa en el módulo
«Movimientos» (con la insignia 🔔). No se envía correo desde aquí.
(El aviso por correo de facturación a Johanna vive en routers/odoo_factura.py.)

Diseño defensivo: NUNCA lanza. Si la auditoría falla, la operación principal
del usuario no se ve afectada (solo se imprime el error en logs).
"""
from database import get_supabase_client

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


def registrar(*, actor_user_id, action, entity, module=None, client_id=None,
              identificacion=None, contribuyente=None, cantidad=None, metadata=None):
    """Registra un movimiento en la bitácora (solo en la app). Nunca lanza."""
    try:
        if client_id and (identificacion is None or contribuyente is None):
            ruc, nom = _datos_cliente(client_id)
            identificacion = identificacion or ruc
            contribuyente = contribuyente or nom
        get_supabase_client().table("activity_log").insert({
            "actor_user_id": actor_user_id,
            "actor_email": _email_de(actor_user_id),
            "action": action,
            "module": module,
            "entity": entity,
            "client_id": client_id,
            "identificacion": identificacion,
            "contribuyente": contribuyente,
            "cantidad": cantidad,
            "metadata": metadata,
        }).execute()
    except Exception as e:
        print(f"[activity] no se pudo registrar movimiento ({entity}): {e}")
