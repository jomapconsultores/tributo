"""Reservas de Capacitación y acompañamiento ($50 + IVA/hora).

Flujo:
  1. El cliente (autenticado) crea una solicitud -> queda 'pendiente'.
     Se avisa al administrador por correo y en la bitácora «Movimientos» (🔔).
  2. El socio o administrador la autoriza/rechaza y agenda la fecha/hora.
     Al decidir, se avisa al cliente por correo.

Autorizar/listar todo requiere rol admin o socio (es_admin). El cliente solo
ve y crea sus propias solicitudes.
"""
import os
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import get_current_user
from database import get_supabase_client
from routers.access import es_admin
from services.email_sender import enviar_correo
from services import activity

router = APIRouter(prefix="/api/capacitaciones", tags=["capacitaciones"])

ADMIN_EMAIL = (os.environ.get("ADMIN_EMAIL") or "jomapconsultores@gmail.com").strip()
ESTADOS = {"pendiente", "autorizada", "rechazada", "realizada"}


class CapacitacionCreate(BaseModel):
    tema: Optional[str] = None
    modalidad: Optional[str] = "online"        # online | presencial
    fecha_sugerida: Optional[str] = None        # YYYY-MM-DD
    hora_sugerida: Optional[str] = None
    horas: Optional[float] = 1
    mensaje: Optional[str] = None


class CapacitacionUpdate(BaseModel):
    estado: Optional[str] = None                # autorizada | rechazada | realizada | pendiente
    fecha_agendada: Optional[str] = None        # ISO datetime
    nota_admin: Optional[str] = None
    horas: Optional[float] = None


def _email_de(uid: str) -> str:
    if not uid:
        return ""
    try:
        res = get_supabase_client().auth.admin.get_user_by_id(uid)
        user = getattr(res, "user", None) or res
        return getattr(user, "email", "") or ""
    except Exception:
        return ""


@router.post("/")
async def crear(body: CapacitacionCreate, user_id: str = Depends(get_current_user)):
    """El cliente solicita una hora de capacitación. Queda 'pendiente' y avisa al admin."""
    sb = get_supabase_client()
    email = _email_de(user_id)
    row = {
        "solicitante_id": user_id,
        "solicitante_email": email,
        "tema": (body.tema or "").strip() or None,
        "modalidad": (body.modalidad or "online").strip(),
        "fecha_sugerida": body.fecha_sugerida or None,
        "hora_sugerida": (body.hora_sugerida or "").strip() or None,
        "horas": body.horas or 1,
        "mensaje": (body.mensaje or "").strip() or None,
        "estado": "pendiente",
    }
    creado = sb.table("capacitaciones").insert(row).execute().data
    nuevo = creado[0] if creado else row

    # Aviso al administrador: correo + bitácora (insignia 🔔). Defensivo.
    try:
        asunto = "🎓 Nueva solicitud de Capacitación y acompañamiento"
        cuerpo = (
            "Un cliente solicitó una hora de Capacitación y acompañamiento.\n\n"
            f"Cliente:        {email}\n"
            f"Tema:           {row['tema'] or '(sin especificar)'}\n"
            f"Modalidad:      {row['modalidad']}\n"
            f"Fecha sugerida: {row['fecha_sugerida'] or '(sin especificar)'} {row['hora_sugerida'] or ''}\n"
            f"Horas:          {row['horas']}\n"
            f"Mensaje:        {row['mensaje'] or '(sin mensaje)'}\n\n"
            "Autoriza o rechaza la reserva en el módulo «Capacitaciones» de la app."
        )
        ok, err = enviar_correo(ADMIN_EMAIL, asunto, cuerpo)
        if not ok:
            print(f"[capacitaciones] no se pudo avisar al admin: {err}")
    except Exception as e:
        print(f"[capacitaciones] error avisando al admin: {e}")

    activity.registrar(
        actor_user_id=user_id,
        action="solicitud",
        entity="capacitacion",
        module="capacitaciones",
        metadata={"email": email, "tema": row["tema"], "fecha_sugerida": row["fecha_sugerida"]},
    )
    return {"ok": True, "data": nuevo}


@router.get("/mias")
async def mias(user_id: str = Depends(get_current_user)):
    """Solicitudes del propio cliente."""
    sb = get_supabase_client()
    data = sb.table("capacitaciones").select("*").eq("solicitante_id", user_id)\
        .order("created_at", desc=True).execute().data or []
    return {"data": data}


@router.get("/")
async def listar(estado: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    """Listado para socio/administrador (todas las solicitudes)."""
    if not es_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo socio o administrador")
    sb = get_supabase_client()
    q = sb.table("capacitaciones").select("*")
    if estado in ESTADOS:
        q = q.eq("estado", estado)
    data = q.order("created_at", desc=True).execute().data or []
    return {"data": data}


@router.put("/{cap_id}")
async def actualizar(cap_id: int, body: CapacitacionUpdate, user_id: str = Depends(get_current_user)):
    """El socio/administrador autoriza, rechaza, agenda o marca como realizada."""
    if not es_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo socio o administrador")
    sb = get_supabase_client()
    actual = sb.table("capacitaciones").select("*").eq("id", cap_id).execute().data
    if not actual:
        raise HTTPException(status_code=404, detail="Solicitud no encontrada")

    upd = {"updated_at": datetime.now(timezone.utc).isoformat(), "autorizada_por": user_id}
    if body.estado is not None:
        if body.estado not in ESTADOS:
            raise HTTPException(status_code=400, detail=f"Estado inválido ({' | '.join(sorted(ESTADOS))})")
        upd["estado"] = body.estado
    if body.fecha_agendada is not None:
        upd["fecha_agendada"] = body.fecha_agendada or None
    if body.nota_admin is not None:
        upd["nota_admin"] = body.nota_admin.strip() or None
    if body.horas is not None:
        upd["horas"] = body.horas

    sb.table("capacitaciones").update(upd).eq("id", cap_id).execute()

    # Avisar al cliente de la decisión (autorizada/rechazada). Defensivo.
    estado = upd.get("estado")
    dest = actual[0].get("solicitante_email")
    if estado in ("autorizada", "rechazada") and dest:
        try:
            if estado == "autorizada":
                asunto = "✅ Tu capacitación fue confirmada"
                cuando = upd.get("fecha_agendada") or actual[0].get("fecha_sugerida") or "(coordinaremos contigo)"
                cuerpo = (
                    "¡Buenas noticias! Tu solicitud de Capacitación y acompañamiento fue confirmada.\n\n"
                    f"Fecha/hora: {cuando}\n"
                    f"{('Nota: ' + upd['nota_admin']) if upd.get('nota_admin') else ''}\n\n"
                    "Gracias por confiar en Gestor SRI."
                )
            else:
                asunto = "Sobre tu solicitud de capacitación"
                cuerpo = (
                    "Recibimos tu solicitud de Capacitación y acompañamiento, pero por ahora no pudimos confirmarla.\n\n"
                    f"{('Motivo: ' + upd['nota_admin']) if upd.get('nota_admin') else 'Te contactaremos para reagendar.'}\n\n"
                    "Escríbenos por WhatsApp y coordinamos otra fecha."
                )
            ok, err = enviar_correo(dest, asunto, cuerpo)
            if not ok:
                print(f"[capacitaciones] no se pudo avisar al cliente: {err}")
        except Exception as e:
            print(f"[capacitaciones] error avisando al cliente: {e}")

    return {"ok": True}
