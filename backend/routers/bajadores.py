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

Y es POR UN PLAZO, de tres meses como máximo. Vencido, el marcador se apaga
solo: nadie tiene que acordarse de revocarlo. Renovar es un acto del
administrador y vuelve a contar desde el día de la renovación, así que nunca
queda más de un trimestre por delante. La única llave sin vencimiento es la del
dueño de la herramienta, que el sistema se crea sola.

El endpoint que consulta el marcador (`/permiso`) es el único sin sesión: corre
en el portal del SRI, otro origen, sin cookies ni token del usuario. Por eso va
con la llave en el cuerpo y responde con CORS abierto —no expone datos: contesta
sí o no y deja registro—.
"""
import calendar
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from auth import get_current_user
from database import get_supabase_client
from routers.access import es_super_admin
from services.activity import registrar

router = APIRouter(prefix="/api/bajadores", tags=["bajadores"])

# La ruta que consulta el marcador desde el portal del SRI. Vive acá porque
# main.py necesita nombrarla para dejar pasar su preflight: el CORS general
# rechaza ese origen, y sin esto el marcador no puede ni preguntar.
RUTA_PERMISO = "/api/bajadores/permiso"

# Los tres marcadores. 'todos' es la llave que sirve para los tres.
CUALES = {"gastos", "emitidos", "devolucion", "todos"}

# Techo del plazo. La autorización se da por meses y no puede pasar de acá: la
# idea es que renovar sea una decisión que se toma seguido, no un trámite que se
# hace una vez y se olvida.
MESES_MAX = 3

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


def _falta_la_columna(e: Exception) -> bool:
    """True si la base todavía no tiene las columnas del plazo.

    Pasa cuando el código sube antes que la migración 066. Sin esto el error
    llega como un «APIError» pelado y hay que ir a buscar al log del servidor
    qué fue lo que pasó."""
    # 42703 = undefined_column (PostgreSQL); PGRST204 = PostgREST no la ve en su
    # caché de esquema, que es lo que devuelve cuando la columna no existe.
    if getattr(e, "code", None) in ("42703", "PGRST204"):
        return True
    msg = str(e).lower()
    return "vence_at" in msg or "renovaciones" in msg or "renovada_at" in msg


def _revisar_migracion(e: Exception):
    """Convierte el fallo por migración pendiente en algo que se pueda leer."""
    if _falta_la_columna(e):
        raise HTTPException(status_code=503, detail=(
            "La base todavía no tiene el plazo de las autorizaciones. Falta correr "
            "la migración 066_bajadores_vigencia.sql en el servidor; hasta entonces "
            "no se puede autorizar ni renovar."))
    raise e


def _user_id_valido(valor: str) -> str:
    """El identificador de la persona, comprobado antes de tocar la base.

    La columna es uuid: mandarle un correo revienta con un 22P02 que llega al
    administrador como «APIError» y no dice nada. Vale la pena verificarlo acá y
    contestar qué se mandó de más."""
    v = (valor or "").strip()
    try:
        return str(uuid.UUID(v))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=400, detail=(
            f"«{v[:60]}» no es un identificador de usuario válido. Hay que mandar el "
            "user_id, no el correo."))


def _meses_validos(meses) -> int:
    """El plazo pedido, acotado al techo. Fuera de rango es error del que llama."""
    try:
        m = int(meses)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="El plazo va en meses enteros.")
    if not 1 <= m <= MESES_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"El plazo va de 1 a {MESES_MAX} meses. Para más tiempo, se renueva al vencer.")
    return m


def _vence_en(meses: int) -> str:
    """Fecha de caducidad contando desde ahora, en meses de calendario.

    Se suman meses, no días: autorizar el 15 vence el 15. Si el mes destino no
    tiene ese día (el 31 de enero a un mes), cae en el último del mes."""
    base = datetime.now(timezone.utc)
    total = base.month - 1 + meses
    anio = base.year + total // 12
    mes = total % 12 + 1
    dia = min(base.day, calendar.monthrange(anio, mes)[1])
    return base.replace(year=anio, month=mes, day=dia).isoformat()


def _fecha(valor) -> Optional[datetime]:
    """Lee una fecha de la base sin romperse por el formato ni por la zona."""
    if not valor:
        return None
    try:
        d = datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _vencida(llave: dict) -> bool:
    """¿Se le pasó el plazo?

    Sin fecha no vence: es la llave del dueño. Pero una fecha que existe y no se
    puede leer cuenta como vencida —esto decide quién entra al portal del SRI, y
    ante un dato roto conviene cortar y que alguien lo mire, no dejar pasar."""
    crudo = llave.get("vence_at")
    if not crudo:
        return False
    fin = _fecha(crudo)
    if not fin:
        return True
    return fin <= datetime.now(timezone.utc)


def _dias_restantes(llave: dict) -> Optional[int]:
    fin = _fecha(llave.get("vence_at"))
    if not fin:
        return None
    return (fin - datetime.now(timezone.utc)).days


def _apto(sb, user_id: str, cual: str) -> Optional[dict]:
    """La llave vigente de esta persona para ese bajador, si la tiene."""
    return _apto_con_motivo(sb, user_id, cual)[0]


def _apto_con_motivo(sb, user_id: str, cual: str) -> Tuple[Optional[dict], Optional[str]]:
    """Como `_apto`, pero además dice por qué no sirve: para poder explicarlo.

    Distinguir «vencida» de «nunca la tuvo» importa: son dos conversaciones
    distintas con el administrador."""
    filas = sb.table("bajadores_llaves").select("*").eq("user_id", user_id).execute().data or []
    caducada = None
    for f in filas:
        if f.get("cual") not in (cual, "todos"):
            continue
        if not f.get("activa"):
            continue
        if _vencida(f):
            caducada = f
            continue
        return f, None
    return (None, "vencida") if caducada else (None, None)


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

    if _vencida(llave):
        _anotar_uso(sb, llave=llave, resultado="vencida", cuerpo=body, ip=ip)
        fin = _fecha(llave.get("vence_at"))
        return JSONResponse({
            "ok": False, "motivo": "vencida",
            "detalle": "Tu autorización venció"
                       + (f" el {fin.strftime('%d/%m/%Y')}" if fin else "")
                       + ". Pedile al administrador que te la renueve: no hace falta "
                         "volver a bajar el marcador, con renovarla vuelve a andar.",
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


def _llave_con_motivo(user_id: str, cual: str) -> Tuple[Optional[dict], Optional[str]]:
    """La llave vigente de esta persona para ese uso, y si no, por qué no.

    Al administrador de la plataforma se le crea sola —es el dueño de la
    herramienta, y la suya no caduca—; el resto necesita que se la habiliten uno
    por uno y por un plazo."""
    if cual not in CUALES:
        raise HTTPException(status_code=400, detail=f"Bajador inválido: {sorted(CUALES)}")
    sb = get_supabase_client()
    llave, motivo = _apto_con_motivo(sb, user_id, cual)
    if not llave and not motivo and es_super_admin(user_id):
        res = sb.table("bajadores_llaves").insert({
            "user_id": user_id, "cual": "todos", "llave": _llave_nueva(),
            "autorizada_por": user_id, "nota": "Dueño de la herramienta",
        }).execute()
        llave = (res.data or [None])[0]
    return llave, motivo


def llave_activa(user_id: str, cual: str = "todos") -> Optional[dict]:
    """La llave vigente de esta persona para ese uso, o None."""
    return _llave_con_motivo(user_id, cual)[0]


def requiere_llave(cual: str, que: str = "los bajadores del SRI"):
    """Dependencia de ruta: sin autorización nominal vigente, no se pasa.

    Es la MISMA llave que habilita los marcadores, usada acá para cerrar
    acciones de la propia app (armar y enviar una devolución de IVA). Tener el
    módulo contratado no alcanza: la autorización se da de a uno y por un plazo,
    en Administración → Bajadores SRI. Revocarla corta el acceso en el acto, y
    cuando se cumple el plazo se corta solo."""
    def _dep(user_id: str = Depends(get_current_user)) -> str:
        llave, motivo = _llave_con_motivo(user_id, cual)
        if llave:
            return user_id
        if motivo == "vencida":
            raise HTTPException(status_code=403, detail=(
                f"Tu autorización para usar {que} venció. Pedile al administrador "
                "que te la renueve."))
        raise HTTPException(status_code=403, detail=(
            f"No estás autorizado a usar {que}. La autorización se da de a uno, "
            "desde el sistema: pedila al administrador."))
    return _dep


@router.get("/mi-llave")
async def mi_llave(cual: str = "todos", user_id: str = Depends(get_current_user)):
    """La llave de quien está usando el sistema, para incrustarla en su marcador."""
    llave, motivo = _llave_con_motivo(user_id, cual)
    if not llave:
        if motivo == "vencida":
            raise HTTPException(status_code=403, detail=(
                "Tu autorización para usar los bajadores del SRI venció. Pedile al "
                "administrador que te la renueve."))
        raise HTTPException(status_code=403, detail=(
            "No estás autorizado a usar los bajadores del SRI. La autorización se da "
            "de a uno, desde el sistema."))
    return {
        "llave": llave["llave"],
        "cual": llave["cual"],
        "equipo_activado": bool(llave.get("dispositivo")),
        "equipo": llave.get("dispositivo_nombre"),
        # Para que el panel pueda avisar antes de que se corte el trabajo.
        "vence_at": llave.get("vence_at"),
        "dias_restantes": _dias_restantes(llave),
    }



# --- Administración: quién puede, desde qué máquina, y con qué historial -----

def _solo_admin(user_id: str):
    if not es_super_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo el administrador maneja estos permisos.")


class AutorizarIn(BaseModel):
    user_id: str
    cual: str = "todos"
    nota: Optional[str] = None
    # Por cuántos meses. El techo son MESES_MAX; pasarse es error, no se recorta
    # en silencio.
    meses: int = MESES_MAX


@router.get("/llaves")
async def listar_llaves(user_id: str = Depends(get_current_user)):
    _solo_admin(user_id)
    sb = get_supabase_client()
    llaves = sb.table("bajadores_llaves").select("*").order("created_at", desc=True).execute().data or []
    for l in llaves:
        # El secreto no se devuelve entero: alcanza con reconocerlo.
        l["llave"] = (l.get("llave") or "")[:6] + "…"
        # La pantalla no vuelve a calcular el plazo: lo dice el servidor, que es
        # el que manda a la hora de dejar pasar o no.
        l["vencida"] = _vencida(l)
        l["dias_restantes"] = _dias_restantes(l)
    return {"llaves": llaves, "meses_max": MESES_MAX}


@router.post("/llaves")
async def autorizar(body: AutorizarIn, user_id: str = Depends(get_current_user)):
    """Habilita a una persona por un plazo. Es la autorización de a uno."""
    _solo_admin(user_id)
    if body.cual not in CUALES:
        raise HTTPException(status_code=400, detail=f"Bajador inválido: {sorted(CUALES)}")
    destinatario = _user_id_valido(body.user_id)
    meses = _meses_validos(body.meses)
    vence = _vence_en(meses)
    sb = get_supabase_client()
    previa = sb.table("bajadores_llaves").select("*").eq(
        "user_id", destinatario).eq("cual", body.cual).execute().data or []
    if previa:
        # Volver a autorizar a alguien que ya tuvo llave reusa la suya: el
        # marcador que ya tiene bajado sigue sirviendo, solo vuelve a correr el
        # plazo desde hoy.
        try:
            sb.table("bajadores_llaves").update({
                "activa": True, "nota": body.nota, "autorizada_por": user_id,
                "vence_at": vence, "updated_at": _ahora(),
            }).eq("id", previa[0]["id"]).execute()
        except Exception as e:
            _revisar_migracion(e)
        registrar(actor_user_id=user_id, action="update", module="admin",
                  entity=f"Permiso de bajadores (reactivado por {meses} mes(es))")
        return {"ok": True, "reactivada": True, "vence_at": vence}
    try:
        sb.table("bajadores_llaves").insert({
            "user_id": destinatario, "cual": body.cual, "llave": _llave_nueva(),
            "autorizada_por": user_id, "nota": body.nota, "vence_at": vence,
        }).execute()
    except Exception as e:
        _revisar_migracion(e)
    registrar(actor_user_id=user_id, action="create", module="admin",
              entity=f"Permiso de bajadores ({meses} mes(es))")
    return {"ok": True, "reactivada": False, "vence_at": vence}


class RenovarIn(BaseModel):
    meses: int = MESES_MAX


@router.post("/llaves/{llave_id}/renovar")
async def renovar(llave_id: str, body: RenovarIn,
                  user_id: str = Depends(get_current_user)):
    """Le da más plazo a una llave que ya existe.

    Cuenta desde HOY, no desde el vencimiento anterior: renovar antes de tiempo
    no acumula, así que nunca hay más de MESES_MAX por delante. La llave es la
    misma, o sea que quien la tenía no vuelve a bajar el marcador."""
    _solo_admin(user_id)
    meses = _meses_validos(body.meses)
    sb = get_supabase_client()
    filas = sb.table("bajadores_llaves").select("*").eq("id", llave_id).execute().data or []
    if not filas:
        raise HTTPException(status_code=404, detail="Esa autorización no existe.")
    vence = _vence_en(meses)
    try:
        sb.table("bajadores_llaves").update({
            "vence_at": vence,
            "renovada_at": _ahora(),
            "renovaciones": int(filas[0].get("renovaciones") or 0) + 1,
            # Renovar una vencida la deja andando de nuevo; revocarla es otra
            # cosa y se hace aparte.
            "activa": True,
            "updated_at": _ahora(),
        }).eq("id", llave_id).execute()
    except Exception as e:
        _revisar_migracion(e)
    registrar(actor_user_id=user_id, action="update", module="admin",
              entity=f"Permiso de bajadores (renovado por {meses} mes(es))")
    return {"ok": True, "vence_at": vence}


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
