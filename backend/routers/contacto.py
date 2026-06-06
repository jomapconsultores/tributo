"""Formulario de contacto público (landing). No requiere autenticación."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_supabase_client

router = APIRouter(prefix="/api/contacto", tags=["contacto"])


class ContactoIn(BaseModel):
    nombre: str
    email: str
    telefono: Optional[str] = ""
    mensaje: Optional[str] = ""


@router.post("/")
async def crear_contacto(entry: ContactoIn):
    nombre = (entry.nombre or "").strip()
    email = (entry.email or "").strip()
    if not nombre or "@" not in email:
        raise HTTPException(status_code=400, detail="Nombre y un email válido son obligatorios")
    try:
        get_supabase_client().table("contactos").insert({
            "nombre": nombre, "email": email,
            "telefono": (entry.telefono or "").strip(),
            "mensaje": (entry.mensaje or "").strip(),
        }).execute()
        return {"ok": True, "message": "Mensaje recibido. Te contactaremos pronto."}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
