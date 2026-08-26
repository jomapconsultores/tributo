# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Permiso de uso de los bajadores/enviadores del SRI.

QUÉ PROTEGE Y QUÉ NO. Los marcadores son código que corre en el navegador de
quien los tiene: se pueden copiar, y ningún candado escrito DENTRO del JS
aguanta a alguien que sepa editarlo. Lo que sí se puede —y es lo que hace este
módulo— es que no sirvan sin permiso vivo: antes de tocar el portal del SRI, el
marcador pregunta acá si su llave está habilitada y si la máquina es la
autorizada. Revocada la llave, el marcador se apaga en el acto; usado desde otra
PC, no arranca; y cada intento queda en la bitácora, salga bien o mal.

La autorización es de a UNO: se le crea la llave a la persona (no al módulo).
Quien no tenga llave activa no puede usarlos aunque tenga acceso a Gastos o a
Devoluciones.

El endpoint que consulta el marcador (`/permiso`) es el único sin sesión: corre
en el portal del SRI, otro origen, sin cookies ni token del usuario. Por eso va
con la llave en el cuerpo y responde con CORS abierto —no expone datos: contesta
sí o no y deja registro—.
"""
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from auth import get_current_user
from database import get_supabase_client
from routers.access import es_super_admin
from services.activity import registrar

router = APIRouter(prefix="/api/bajadores", tags=["bajadores"])

# Los tres marcadores. 'todos' es la llave que sirve para los tres.
CUALES = {"gastos", "emitidos", "devolucion", "todos"}

# El marcador corre en el portal del SRI y en la propia app; la respuesta no
# lleva datos de nadie, así que el origen puede ser cualquiera.
CORS_ABIERTO = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
}


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _llave_nueva() -> str:
    # 32 bytes en base64url: suficiente para que no se adivine, corto para que
    # entre en el marcador sin estorbar.
    return secrets.token_urlsafe(32)


def _apto(sb, user_id: str, cual: str) -> Optional[dict]:
    """La llave activa de esta persona para ese bajador, si la tiene."""
    filas = sb.table("bajadores_llaves").select("*").eq("user_id", user_id).execute().data or []
    for f in filas:
        if f.get("cual") in (cual, "todos") and f.get("activa"):
            return f
    return None


def _anotar_uso(sb, *, llave, resultado, cuerpo, ip):
    try:
        sb.table("bajadores_usos").insert({
            "llave_id": (llave or {}).get("id"),
            "user_id": (llave or {}).get("user_id"),
            "cual": cuerpo.cual,
            "resultado": resultado,
            "dispositivo": cuerpo.dispositivo,
            "dispositivo_nombre": (cuerpo.dispositivo_nombre or "")[:200],
            "ip": ip,
            "identificacion": cuerpo.identificacion,
            "periodo": cuerpo.periodo,
        }).execute()
    except Exception:
        pass        # la bitácora no puede tumbar el permiso


class PermisoIn(BaseModel):
    llave: str
    # Huella de la máquina, calculada por el marcador (plataforma, pantalla,
    # zona horaria, núcleos…). No identifica a la persona: distingue equipos.
    dispositivo: str
    dispositivo_nombre: Optional[str] = None
    cual: str = "todos"
    # Contexto del trámite, para la bitácora.
    identificacion: Optional[str] = None
    periodo: Optional[str] = None


@router.options("/permiso")
async def permiso_options():
    return JSONResponse({}, headers=CORS_ABIERTO)


@router.post("/permiso")
async def permiso(body: PermisoIn, request: Request):
    """¿Puede correr este marcador, acá y ahora? Lo consulta el propio marcador.

    Responde siempre 200 con `ok` adentro: un 401 en una llamada cross-origin se
    confunde con "no hay internet", y el marcador tiene que poder decirle al
    usuario POR QUÉ no arranca."""
    sb = get_supabase_client()
    ip = (request.client.host if request.client else None)
    filas = sb.table("bajadores_llaves").select("*").eq("llave", body.llave).execute().data or []
    llave = filas[0] if filas else None

    if not llave:
        _anotar_uso(sb, llave=None, resultado="desconocida", cuerpo=body, ip=ip)
        return JSONResponse({
            "ok": False, "motivo": "desconocida",
            "detalle": "Este marcador no está autorizado. Bajalo desde el sistema, "
                       "con tu cuenta: el que se pasa de mano en mano no sirve.",
        }, headers=CORS_ABIERTO)

    if not llave.get("activa"):
        _anotar_uso(sb, llave=llave, resultado="revocada", cuerpo=body, ip=ip)
        return JSONResponse({
            "ok": False, "motivo": "revocada",
            "detalle": "Este marcador fue dado de baja. Pedí que te habiliten de nuevo "
                       "en el sistema y volvé a bajarlo.",
        }, headers=CORS_ABIERTO)

    if llave.get("cual") not in (body.cual, "todos"):
        _anotar_uso(sb, llave=llave, resultado="otro_bajador", cuerpo=body, ip=ip)
        return JSONResponse({
            "ok": False, "motivo": "otro_bajador",
            "detalle": "Tu permiso no cubre este bajador.",
        }, headers=CORS_ABIERTO)

    equipo = (llave.get("dispositivo") or "").strip()
    if not equipo:
        # Primera vez: la llave se ata a ESTA máquina. Es el momento en que
        # "una sola máquina" se vuelve efectivo, sin que nadie tenga que
        # anotar nada a mano.
        sb.table("bajadores_llaves").update({
            "dispositivo": body.dispositivo,
            "dispositivo_nombre": (body.dispositivo_nombre or "")[:200],
            "activada_at": _ahora(),
            "ultimo_uso_at": _ahora(),
            "usos": int(llave.get("usos") or 0) + 1,
            "updated_at": _ahora(),
        }).eq("id", llave["id"]).execute()
        _anotar_uso(sb, llave=llave, resultado="activada", cuerpo=body, ip=ip)
        return JSONResponse({"ok": True, "motivo": "activada",
                             "detalle": "Marcador activado en esta máquina."},
                            headers=CORS_ABIERTO)

    if equipo != body.dispositivo:
        _anotar_uso(sb, llave=llave, resultado="otra_maquina", cuerpo=body, ip=ip)
        return JSONResponse({
            "ok": False, "motivo": "otra_maquina",
            "detalle": "Este permiso está activado en otra computadora"
                       + (f" ({llave.get('dispositivo_nombre')})" if llave.get("dispositivo_nombre") else "")
                       + ". Si cambiaste de equipo, pedí que lo liberen en el sistema.",
        }, headers=CORS_ABIERTO)

    sb.table("bajadores_llaves").update({
        "ultimo_uso_at": _ahora(),
        "usos": int(llave.get("usos") or 0) + 1,
        "updated_at": _ahora(),
    }).eq("id", llave["id"]).execute()
    _anotar_uso(sb, llave=llave, resultado="ok", cuerpo=body, ip=ip)
    return JSONResponse({"ok": True, "motivo": "ok"}, headers=CORS_ABIERTO)


def llave_activa(user_id: str, cual: str = "todos") -> Optional[dict]:
    """La llave vigente de esta persona para ese uso, o None.

    Al administrador de la plataforma se le crea sola —es el dueño de la
    herramienta—; el resto necesita que se la habiliten uno por uno."""
    if cual not in CUALES:
        raise HTTPException(status_code=400, detail=f"Bajador inválido: {sorted(CUALES)}")
    sb = get_supabase_client()
    llave = _apto(sb, user_id, cual)
    if not llave and es_super_admin(user_id):
        res = sb.table("bajadores_llaves").insert({
            "user_id": user_id, "cual": "todos", "llave": _llave_nueva(),
            "autorizada_por": user_id, "nota": "Dueño de la herramienta",
        }).execute()
        llave = (res.data or [None])[0]
    return llave


def requiere_llave(cual: str, que: str = "los bajadores del SRI"):
    """Dependencia de ruta: sin autorización nominal vigente, no se pasa.

    Es la MISMA llave que habilita los marcadores, usada acá para cerrar
    acciones de la propia app (armar y enviar una devolución de IVA). Tener el
    módulo contratado no alcanza: la autorización se da de a uno, en
    Administración → Bajadores SRI, y revocarla corta el acceso en el acto."""
    def _dep(user_id: str = Depends(get_current_user)) -> str:
        if not llave_activa(user_id, cual):
            raise HTTPException(status_code=403, detail=(
                f"No estás autorizado a usar {que}. La autorización se da de a uno, "
                "desde el sistema: pedila al administrador."))
        return user_id
    return _dep


@router.get("/mi-llave")
async def mi_llave(cual: str = "todos", user_id: str = Depends(get_current_user)):
    """La llave de quien está usando el sistema, para incrustarla en su marcador."""
    llave = llave_activa(user_id, cual)
    if not llave:
        raise HTTPException(status_code=403, detail=(
            "No estás autorizado a usar los bajadores del SRI. La autorización se da "
            "de a uno, desde el sistema."))
    return {
        "llave": llave["llave"],
        "cual": llave["cual"],
        "equipo_activado": bool(llave.get("dispositivo")),
        "equipo": llave.get("dispositivo_nombre"),
    }



# --- Administración: quién puede, desde qué máquina, y con qué historial -----

def _solo_admin(user_id: str):
    if not es_super_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo el administrador maneja estos permisos.")


class AutorizarIn(BaseModel):
    user_id: str
    cual: str = "todos"
    nota: Optional[str] = None


@router.get("/llaves")
async def listar_llaves(user_id: str = Depends(get_current_user)):
    _solo_admin(user_id)
    sb = get_supabase_client()
    llaves = sb.table("bajadores_llaves").select("*").order("created_at", desc=True).execute().data or []
    # El secreto no se devuelve entero: alcanza con reconocerlo.
    for l in llaves:
        l["llave"] = (l.get("llave") or "")[:6] + "…"
    return {"llaves": llaves}


@router.post("/llaves")
async def autorizar(body: AutorizarIn, user_id: str = Depends(get_current_user)):
    """Habilita a una persona. Es la autorización de a uno."""
    _solo_admin(user_id)
    if body.cual not in CUALES:
        raise HTTPException(status_code=400, detail=f"Bajador inválido: {sorted(CUALES)}")
    sb = get_supabase_client()
    previa = sb.table("bajadores_llaves").select("*").eq(
        "user_id", body.user_id).eq("cual", body.cual).execute().data or []
    if previa:
        sb.table("bajadores_llaves").update({
            "activa": True, "nota": body.nota, "autorizada_por": user_id, "updated_at": _ahora(),
        }).eq("id", previa[0]["id"]).execute()
        registrar(actor_user_id=user_id, action="update", module="admin",
                  entity="Permiso de bajadores (reactivado)")
        return {"ok": True, "reactivada": True}
    sb.table("bajadores_llaves").insert({
        "user_id": body.user_id, "cual": body.cual, "llave": _llave_nueva(),
        "autorizada_por": user_id, "nota": body.nota,
    }).execute()
    registrar(actor_user_id=user_id, action="create", module="admin",
              entity="Permiso de bajadores")
    return {"ok": True, "reactivada": False}


class EstadoLlaveIn(BaseModel):
    activa: bool


@router.post("/llaves/{llave_id}/estado")
async def cambiar_estado(llave_id: str, body: EstadoLlaveIn,
                         user_id: str = Depends(get_current_user)):
    """Revoca (o vuelve a habilitar). Revocada, el marcador se apaga en el acto."""
    _solo_admin(user_id)
    sb = get_supabase_client()
    sb.table("bajadores_llaves").update(
        {"activa": bool(body.activa), "updated_at": _ahora()}).eq("id", llave_id).execute()
    registrar(actor_user_id=user_id, action="update", module="admin",
              entity=f"Permiso de bajadores ({'habilitado' if body.activa else 'revocado'})")
    return {"ok": True}


@router.post("/llaves/{llave_id}/liberar-equipo")
async def liberar_equipo(llave_id: str, user_id: str = Depends(get_current_user)):
    """Suelta la máquina para que la llave se active en otra (cambio de PC)."""
    _solo_admin(user_id)
    sb = get_supabase_client()
    sb.table("bajadores_llaves").update({
        "dispositivo": None, "dispositivo_nombre": None, "activada_at": None,
        "updated_at": _ahora(),
    }).eq("id", llave_id).execute()
    registrar(actor_user_id=user_id, action="update", module="admin",
              entity="Permiso de bajadores (equipo liberado)")
    return {"ok": True}


@router.get("/usos")
async def usos(limite: int = 100, user_id: str = Depends(get_current_user)):
    """La bitácora: quién usó los bajadores, desde qué máquina y sobre qué."""
    _solo_admin(user_id)
    sb = get_supabase_client()
    filas = sb.table("bajadores_usos").select("*").order(
        "created_at", desc=True).limit(min(int(limite or 100), 500)).execute().data or []
    return {"usos": filas}
