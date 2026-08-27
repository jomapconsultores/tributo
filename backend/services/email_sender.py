# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Envío de correo por SMTP. Las credenciales se leen de variables de entorno
(NUNCA del código): SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM.
Si no están configuradas, enviar_correo devuelve (False, motivo) y la app cae
al modo "abrir el correo redactado" (mailto)."""
import os
import smtplib
import ssl
from email.message import EmailMessage


def _cfg():
    # Emisor de las notificaciones: jomapconsultores@gmail.com (Gmail) por defecto.
    user = (os.environ.get("SMTP_USER") or "jomapconsultores@gmail.com").strip()
    return {
        "host": (os.environ.get("SMTP_HOST") or "smtp.gmail.com").strip(),
        "port": int(os.environ.get("SMTP_PORT") or "587"),
        "user": user,
        "password": os.environ.get("SMTP_PASSWORD") or "",
        "from": (os.environ.get("SMTP_FROM") or user).strip(),
    }


def email_configurado():
    c = _cfg()
    return bool(c["host"] and c["user"] and c["password"])


def enviar_correo(destinatario, asunto, cuerpo, copia=None):
    """Devuelve (ok: bool, error: str|None).

    `copia` pone a alguien en Cc —quien vende el producto se entera de lo que
    se le dice al cliente— y admite una dirección o una lista. Si coincide con
    el destinatario se omite, para no mandar el mismo correo dos veces."""
    c = _cfg()
    if not (c["host"] and c["user"] and c["password"]):
        return False, "El envío automático no está configurado en el servidor (faltan variables SMTP)."
    msg = EmailMessage()
    msg["From"] = c["from"]
    msg["To"] = destinatario
    if copia:
        dest = {d.strip().lower() for d in str(destinatario).split(",") if d.strip()}
        cc = [copia] if isinstance(copia, str) else list(copia)
        cc = [d.strip() for d in cc if d and d.strip().lower() not in dest]
        if cc:
            msg["Cc"] = ", ".join(cc)
    msg["Subject"] = asunto
    msg.set_content(cuerpo)
    try:
        ctx = ssl.create_default_context()
        if c["port"] == 465:
            with smtplib.SMTP_SSL(c["host"], c["port"], context=ctx, timeout=30) as s:
                s.login(c["user"], c["password"])
                s.send_message(msg)
        else:
            with smtplib.SMTP(c["host"], c["port"], timeout=30) as s:
                s.ehlo()
                s.starttls(context=ctx)
                s.login(c["user"], c["password"])
                s.send_message(msg)
        return True, None
    except Exception as e:
        return False, f"No se pudo enviar el correo: {e}"
