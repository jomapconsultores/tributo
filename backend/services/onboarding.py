"""Alta automática de clientes nuevos (auto-registro desde el Landing/Login).

Cuando un cliente se registra solo (`/auth/signup`):
  1. Se le activa una PRUEBA gratuita de todos los módulos por `TRIAL_DIAS` días,
     para que pueda usar la app de inmediato sin esperar al administrador.
  2. Se avisa al administrador por dos vías:
       - Correo a ADMIN_EMAIL (jomapconsultores@gmail.com por defecto), reusando
         el SMTP ya configurado en services/email_sender.py.
       - Bitácora «Movimientos» (insignia 🔔), reusando services/activity.py.

Diseño defensivo: NUNCA lanza. Si el aprovisionamiento o el aviso fallan, el
registro del usuario no se ve afectado (solo se imprime el error en logs).
"""
import os
from datetime import date, timedelta
from typing import Optional

from database import get_supabase_client
from services.email_sender import enviar_correo
from services import activity

# Prueba gratuita: días y módulos incluidos (todos, para que prueben todo).
TRIAL_DIAS = 14
TRIAL_MODULOS = ["gastos", "retenciones", "ingresos_ice", "declaraciones"]

# Destinatario del aviso. El SMTP_FROM también es jomapconsultores@gmail.com.
ADMIN_EMAIL = (os.environ.get("ADMIN_EMAIL") or "jomapconsultores@gmail.com").strip()


def _activar_prueba(uid: str) -> str:
    """Crea/actualiza la suscripción en estado 'prueba' y activa los módulos con
    vencimiento al final de la prueba. Devuelve la fecha de fin (YYYY-MM-DD)."""
    sb = get_supabase_client()
    fin = (date.today() + timedelta(days=TRIAL_DIAS)).isoformat()

    sub = {"estado": "prueba", "proximo_pago": fin}
    existing = sb.table("subscriptions").select("user_id").eq("user_id", uid).execute().data
    if existing:
        sb.table("subscriptions").update(sub).eq("user_id", uid).execute()
    else:
        sb.table("subscriptions").insert({"user_id": uid, **sub}).execute()

    for m in TRIAL_MODULOS:
        data = {"activo": True, "valid_until": fin}
        ex = sb.table("user_modules").select("id").eq("user_id", uid).eq("modulo", m).execute().data
        if ex:
            sb.table("user_modules").update(data).eq("id", ex[0]["id"]).execute()
        else:
            sb.table("user_modules").insert({"user_id": uid, "modulo": m, **data}).execute()

    return fin


def _avisar_admin(uid: str, email: str, fin: str):
    """Avisa al administrador del nuevo registro: correo + bitácora Movimientos."""
    # 1) Correo al administrador
    asunto = "🆕 Nuevo cliente registrado en Gestor SRI"
    cuerpo = (
        "Se registró un nuevo cliente en Gestor SRI.\n\n"
        f"Correo:  {email}\n"
        f"Fecha:   {date.today().isoformat()}\n"
        f"Prueba gratuita activa hasta: {fin}  ({TRIAL_DIAS} días, todos los módulos)\n\n"
        "Cuando el cliente realice el pago, regístralo y asígnale su plan en el "
        "panel de Administración."
    )
    try:
        ok, err = enviar_correo(ADMIN_EMAIL, asunto, cuerpo)
        if not ok:
            print(f"[onboarding] no se pudo enviar el correo de aviso: {err}")
    except Exception as e:
        print(f"[onboarding] error enviando correo de aviso: {e}")

    # 2) Bitácora «Movimientos» (insignia 🔔). registrar() nunca lanza.
    activity.registrar(
        actor_user_id=uid,
        action="registro",
        entity="usuario_nuevo",
        module="acceso",
        metadata={"email": email, "prueba_hasta": fin},
    )


def provisionar_prueba_y_avisar(*, user_id: str, email: str) -> Optional[str]:
    """Activa la prueba y notifica al admin. Defensivo: nunca propaga errores."""
    try:
        fin = _activar_prueba(user_id)
    except Exception as e:
        print(f"[onboarding] no se pudo activar la prueba de {email}: {e}")
        fin = None
    try:
        _avisar_admin(user_id, email, fin or "(sin fecha)")
    except Exception as e:
        print(f"[onboarding] no se pudo avisar al admin del registro de {email}: {e}")
    return fin
