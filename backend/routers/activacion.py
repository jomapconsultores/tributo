# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Activación del acceso: el cliente reporta su pago, el administrador aprueba.

Flujo (el mismo de Capacitaciones, aplicado al cobro):

  1. El cliente sube el comprobante de su transferencia con los datos del pago.
     La solicitud nace 'pendiente' y al administrador le llega un correo y la
     insignia 🔔 en Movimientos.
  2. El administrador abre el comprobante (URL firmada, una hora) y con UN botón
     lo aprueba: se asienta el pago, la suscripción queda 'activa' y se corre la
     fecha del próximo pago. Si el cliente no tenía módulos habilitados se le
     aplica el plan en el mismo acto, porque aprobar un pago y no abrirle nada
     dejaría al cliente pagando por una puerta cerrada.
  3. Si algo no cuadra, lo rechaza con un motivo. El cliente lo ve en la app y
     le llega por correo, sin tener que llamar a preguntar.

IMPORTANTE: este router va SIN dependencia de módulo en main.py. Quien lo usa es
precisamente el cliente al que se le cerró el acceso por falta de pago: si le
pidiéramos un módulo contratado para poder pagar, no podría pagar nunca.

El archivo no se guarda en la base: vive en el bucket privado `comprobantes-pago`
de Storage y la tabla solo guarda su ruta.
"""
import os
import re
from datetime import date, datetime, timezone
from typing import List, NoReturn, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

import orgs
from auth import get_current_user
from database import get_supabase_client
from routers.access import es_super_admin, invalidar_cache_rol, suscripcion
from services import activity, cobro
from services.activity import _email_de
from services.email_sender import enviar_correo

router = APIRouter(prefix="/api/activacion", tags=["activacion"])

ADMIN_EMAIL = (os.environ.get("ADMIN_EMAIL") or "jomapconsultores@gmail.com").strip()
BUCKET = "comprobantes-pago"
ESTADOS = ("pendiente", "aprobado", "rechazado")
METODOS = ("transferencia", "deposito", "efectivo", "tarjeta", "otro")

# Un comprobante es una foto o un PDF. Ocho megas alcanzan de sobra para la
# captura de una transferencia y ponen un techo al tamaño que puede mandar
# cualquiera con sesión abierta.
MAX_BYTES = 8 * 1024 * 1024
TIPOS_OK = ("image/", "application/pdf")
# Tope de comprobantes en espera por usuario: evita que una pantalla trabada
# (o un doble clic con ganas) llene la bandeja del administrador.
MAX_PENDIENTES = 5


def _sb():
    return get_supabase_client()


async def require_admin(user_id: str = Depends(get_current_user)):
    """Aprobar o rechazar un cobro es del administrador de la plataforma, igual
    que el resto del panel de cobros (routers/admin.py)."""
    if not es_super_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo el administrador principal")
    return user_id


def _titular(user_id: str) -> dict:
    """Quién paga: la EMPRESA activa si tiene suscripción propia, o la persona.

    Devuelve {'org_id': ..., 'nombre': ...} con org_id=None en modo heredado."""
    org_id = orgs.org_activa()
    if org_id and orgs.suscripcion_de_org(org_id):
        nombre = None
        try:
            for e in orgs.empresas_visibles(user_id, es_super_admin(user_id)):
                if e.get("org_id") == org_id:
                    nombre = e.get("nombre")
                    break
        except Exception:
            nombre = None
        return {"org_id": org_id, "nombre": nombre}
    return {"org_id": None, "nombre": None}


def _bucket():
    """Crea el bucket privado la primera vez. Defensivo: si falla, la subida
    dará su propio error, que es más claro que morir acá."""
    try:
        sb = _sb()
        nombres = {getattr(b, "name", None) or (b.get("name") if isinstance(b, dict) else None)
                   for b in sb.storage.list_buckets()}
        if BUCKET not in nombres:
            sb.storage.create_bucket(BUCKET, options={"public": False})
    except Exception as e:
        print(f"[activacion] bucket: {e}")


def _precio_sugerido(sub: dict) -> dict:
    """Cuánto tiene que pagar el cliente, por cada plazo, con su descuento.

    Se calcula acá y no en el navegador para que el cliente vea exactamente el
    mismo número que el administrador tiene en su panel."""
    precio = float(sub.get("precio_mensual") or 0)
    iva_incluido = bool(sub.get("iva_incluido"))
    opciones = []
    for meses, desc in sorted(cobro.DESCUENTOS.items()):
        neto = round(precio * meses * (1 - desc), 2)
        opciones.append({
            "meses": meses,
            "descuento": desc,
            "neto": neto,
            # Lo que de verdad se transfiere: con IVA, que es como se paga.
            "total": cobro.total_con_iva(neto, iva_incluido),
        })
    return {"precio_mensual": precio, "iva_incluido": iva_incluido, "opciones": opciones}


def _fecha_valida(valor: Optional[str]) -> str:
    """Fecha del pago en ISO, o la de hoy si llega vacía, mal escrita o futura."""
    hoy = date.today()
    try:
        d = date.fromisoformat((valor or "").strip())
        return (d if d <= hoy else hoy).isoformat()
    except ValueError:
        return hoy.isoformat()


# La tabla puede no estar todavía por dos motivos distintos, y los dos dan un
# error críptico: que la migración 068 no se haya aplicado (Postgres: 42P01
# «relation does not exist») o que sí esté aplicada pero PostgREST siga con el
# esquema viejo en caché (PGRST205 «could not find the table ... in the schema
# cache»). Sin esto el panel solo mostraba «Error del servidor (APIError)», que
# no dice qué hacer.
_PISTAS_SIN_TABLA = ("42p01", "does not exist", "pgrst205", "schema cache")
_COMO_ARREGLARLO = (
    "El módulo de activaciones necesita la tabla `pagos_reportados`, que todavía no está "
    "disponible. Aplica la migración `supabase/migrations/068_activacion_pagos.sql` en la "
    "base y, si ya la aplicaste, recarga el esquema de la API con "
    "NOTIFY pgrst, 'reload schema'; (o reinicia el servicio)."
)


def _sin_tabla(e: Exception) -> bool:
    m = (str(e) or "").lower()
    return "pagos_reportados" in m and any(p in m for p in _PISTAS_SIN_TABLA)


def _relanzar(e: Exception, contexto: str) -> NoReturn:
    """Convierte el error crudo de la base en algo accionable. Siempre lanza."""
    if _sin_tabla(e):
        raise HTTPException(status_code=503, detail=_COMO_ARREGLARLO)
    raise HTTPException(status_code=400, detail=f"{contexto}: {e}")


def _buscar(cid: str, campos: str = "*") -> dict:
    """Un comprobante por id, o 404. Un id que no es un UUID hace fallar la
    consulta en Postgres: se responde 404 igual que si no existiera, en vez de
    dejar escapar un error del servidor por un dato de la URL."""
    try:
        fila = _sb().table("pagos_reportados").select(campos).eq("id", cid).limit(1).execute().data
    except Exception as e:
        # Que falte la tabla no es lo mismo que que falte el comprobante: con un
        # 404 aquí, el administrador buscaría el comprobante en vez de aplicar
        # la migración.
        if _sin_tabla(e):
            _relanzar(e, "")
        fila = None
    if not fila:
        raise HTTPException(status_code=404, detail="Comprobante no encontrado")
    return fila[0]


def _mios(user_id: str, limite: int = 20) -> List[dict]:
    try:
        return _sb().table("pagos_reportados").select("*").eq("user_id", user_id)\
            .order("created_at", desc=True).limit(limite).execute().data or []
    except Exception as e:
        print(f"[activacion] no se pudieron leer los comprobantes de {user_id}: {e}")
        return []


@router.get("/estado")
async def estado(user_id: str = Depends(get_current_user)):
    """Lo que el cliente necesita ver para pagar: su plan, lo que debe, hasta
    cuándo tiene acceso y en qué quedaron los comprobantes que ya mandó."""
    sub = suscripcion(user_id)
    titular = _titular(user_id)
    mios = _mios(user_id)
    return {
        "suscripcion": {
            "plan": sub.get("plan"),
            "estado": sub.get("estado"),
            "precio_mensual": sub.get("precio_mensual"),
            "proximo_pago": sub.get("proximo_pago"),
            "iva_incluido": bool(sub.get("iva_incluido")),
            "vigente": sub.get("vigente", True),
            "vencida": sub.get("vencida", False),
        },
        "titular": titular,
        "cobro": _precio_sugerido(sub),
        "metodos": list(METODOS),
        # Hay uno esperando respuesta: la pantalla lo dice en vez de invitar a
        # mandar otro igual.
        "pendiente": next((c for c in mios if c["estado"] == "pendiente"), None),
        "comprobantes": mios,
    }


@router.post("/comprobantes")
async def enviar_comprobante(
    file: Optional[UploadFile] = File(None),
    monto: float = Form(0),
    meses: int = Form(1),
    fecha_pago: Optional[str] = Form(None),
    metodo: Optional[str] = Form("transferencia"),
    banco: Optional[str] = Form(None),
    referencia: Optional[str] = Form(None),
    nota: Optional[str] = Form(None),
    user_id: str = Depends(get_current_user),
):
    """El cliente informa su pago y adjunta el respaldo. Queda 'pendiente' y se
    avisa al administrador."""
    sb = _sb()
    email = _email_de(user_id)

    try:
        pendientes = sb.table("pagos_reportados").select("id", count="exact")\
            .eq("user_id", user_id).eq("estado", "pendiente").execute().count or 0
    except Exception as e:
        # La tabla todavía no existe (migración 068 sin aplicar): no se bloquea
        # acá, el INSERT de más abajo dará el error de verdad.
        print(f"[activacion] no se pudieron contar los pendientes: {e}")
        pendientes = 0
    if pendientes >= MAX_PENDIENTES:
        raise HTTPException(
            status_code=400,
            detail="Ya tienes comprobantes esperando revisión. Espera a que el administrador los revise.")

    if float(monto or 0) <= 0:
        raise HTTPException(status_code=400, detail="Indica el valor que pagaste.")
    metodo = (metodo or "transferencia").strip().lower()
    if metodo not in METODOS:
        metodo = "otro"
    # Los plazos son los que tienen descuento definido; cualquier otro se lee
    # como un mes, para que la tarjeta del administrador no muestre períodos
    # inventados desde el navegador.
    meses = int(meses or 1)
    if meses not in cobro.DESCUENTOS:
        meses = 1

    path = nombre_archivo = None
    if file is not None and file.filename:
        contenido = await file.read()
        if not contenido:
            raise HTTPException(status_code=400, detail="El archivo llegó vacío. Vuelve a adjuntarlo.")
        if len(contenido) > MAX_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"El archivo pesa más de {MAX_BYTES // (1024 * 1024)} MB. Sube una foto o un PDF más liviano.")
        tipo = (file.content_type or "").lower()
        if not tipo.startswith(TIPOS_OK):
            raise HTTPException(status_code=400, detail="El comprobante debe ser una imagen o un PDF.")
        _bucket()
        seguro = re.sub(r"[^A-Za-z0-9._-]", "_", file.filename)[:120]
        sello = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        path = f"{user_id}/{sello}_{seguro}"
        try:
            sb.storage.from_(BUCKET).upload(
                path, contenido, {"content-type": tipo or "application/octet-stream", "upsert": "true"})
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"No se pudo guardar el comprobante: {e}")
        nombre_archivo = file.filename

    titular = _titular(user_id)
    fila = {
        "user_id": user_id,
        "user_email": email,
        "org_id": titular["org_id"],
        "monto": round(float(monto or 0), 2),
        "meses": meses,
        # Una fecha con otro formato haría fallar el INSERT con un error de
        # Postgres que el cliente no puede entender ni arreglar: se cae al día
        # de hoy, que es el caso normal de quien acaba de pagar.
        "fecha_pago": _fecha_valida(fecha_pago),
        "metodo": metodo,
        "banco": (banco or "").strip() or None,
        "referencia": (referencia or "").strip() or None,
        "nota": (nota or "").strip() or None,
        "comprobante_path": path,
        "comprobante_nombre": nombre_archivo,
        "estado": "pendiente",
    }
    try:
        creado = sb.table("pagos_reportados").insert(fila).execute().data
    except Exception as e:
        _relanzar(e, "No se pudo registrar el pago informado")
    nuevo = creado[0] if creado else fila

    # Aviso al administrador. Defensivo: si el correo falla, el comprobante ya
    # quedó guardado y la insignia igual aparece.
    try:
        cuerpo = (
            "Un cliente informó un pago y espera que le actives el acceso.\n\n"
            f"Cliente:     {email}\n"
            f"Empresa:     {titular['nombre'] or '(a nombre de la persona)'}\n"
            f"Valor:       ${fila['monto']:,.2f}\n"
            f"Meses:       {fila['meses']}\n"
            f"Fecha:       {fila['fecha_pago']}\n"
            f"Método:      {fila['metodo']}\n"
            f"Banco:       {fila['banco'] or '—'}\n"
            f"Referencia:  {fila['referencia'] or '—'}\n"
            f"Comprobante: {nombre_archivo or '(no adjuntó archivo)'}\n"
            f"Nota:        {fila['nota'] or '—'}\n\n"
            "Revísalo y actívalo en Administración → Activaciones."
        )
        ok, err = enviar_correo(ADMIN_EMAIL, "💵 Pago informado: esperando activación", cuerpo)
        if not ok:
            print(f"[activacion] no se pudo avisar al admin: {err}")
    except Exception as e:
        print(f"[activacion] error avisando al admin: {e}")

    activity.registrar(
        actor_user_id=user_id, action="solicitud", entity="Comprobante de pago",
        module="cobros",
        metadata={"email": email, "monto": fila["monto"], "meses": fila["meses"],
                  "metodo": fila["metodo"], "referencia": fila["referencia"]},
    )
    return {"ok": True, "data": nuevo}


@router.get("/mis-comprobantes")
async def mis_comprobantes(user_id: str = Depends(get_current_user)):
    return {"data": _mios(user_id)}


# ---------------------------------------------------------------------------
# Panel del administrador
# ---------------------------------------------------------------------------

@router.get("/resumen")
async def resumen(_: str = Depends(require_admin)):
    """Cuántos comprobantes esperan revisión (alimenta la insignia del menú)."""
    try:
        r = _sb().table("pagos_reportados").select("id", count="exact")\
            .eq("estado", "pendiente").execute()
        return {"pendientes": r.count or 0}
    except Exception as e:
        print(f"[activacion] resumen: {e}")
        return {"pendientes": 0}


@router.get("/comprobantes")
async def listar(estado_filtro: Optional[str] = Query(None, alias="estado"),
                 limit: int = Query(100, ge=1, le=500),
                 _: str = Depends(require_admin)):
    """Comprobantes de todos los clientes, del más nuevo al más viejo."""
    q = _sb().table("pagos_reportados").select("*")
    if estado_filtro in ESTADOS:
        q = q.eq("estado", estado_filtro)
    try:
        data = q.order("created_at", desc=True).limit(limit).execute().data or []
    except Exception as e:
        _relanzar(e, "No se pudieron leer los comprobantes")
    return {"data": data}


@router.get("/comprobantes/{cid}/archivo")
async def archivo(cid: str, user_id: str = Depends(get_current_user)):
    """URL firmada (1 hora) del comprobante. Solo su dueño o el administrador:
    un path adivinado no alcanza para ver el respaldo bancario de otro."""
    fila = _buscar(cid, "user_id,comprobante_path")
    if fila["user_id"] != user_id and not es_super_admin(user_id):
        raise HTTPException(status_code=404, detail="Comprobante no encontrado")
    if not fila.get("comprobante_path"):
        raise HTTPException(status_code=404, detail="Este pago se informó sin archivo adjunto")
    try:
        r = _sb().storage.from_(BUCKET).create_signed_url(fila["comprobante_path"], 3600)
        url = (r.get("signedURL") or r.get("signedUrl") or r.get("signed_url")) if isinstance(r, dict) else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"No se pudo abrir el comprobante: {e}")
    if not url:
        raise HTTPException(status_code=404, detail="No se pudo abrir el comprobante")
    return {"url": url}


class AprobarIn(BaseModel):
    # Todos opcionales: el caso normal es aprobar tal cual lo informó el cliente.
    monto: Optional[float] = None          # si el administrador corrige el valor
    meses: Optional[int] = None
    plan: Optional[str] = None             # activar además este plan de módulos
    iva_incluido: Optional[bool] = None
    nota: Optional[str] = None


class RechazarIn(BaseModel):
    nota: Optional[str] = None             # motivo, se le manda al cliente


def _fila_o_404(cid: str) -> dict:
    return _buscar(cid)


@router.post("/comprobantes/{cid}/aprobar")
async def aprobar(cid: str, body: AprobarIn, admin_id: str = Depends(require_admin)):
    """Aprueba el pago informado y ACTIVA el acceso en un solo acto."""
    from routers.admin import PLANES, _aplicar_modulos

    fila = _fila_o_404(cid)
    if fila["estado"] == "aprobado":
        raise HTTPException(status_code=400, detail="Este comprobante ya fue aprobado")

    uid = fila["user_id"]
    org_id = fila.get("org_id")
    monto = body.monto if body.monto is not None else float(fila.get("monto") or 0)
    meses = int(body.meses if body.meses is not None else (fila.get("meses") or 1))

    # El plan (los módulos que se abren) es del USUARIO aunque pague la empresa:
    # es su cuenta la que tiene que poder entrar. OJO en multiempresa: si su
    # membresía define módulos propios, mandan esos y lo que se escriba acá
    # queda de reserva; los permisos por empresa se editan en «Empresas».
    if body.plan:
        if body.plan not in PLANES:
            raise HTTPException(status_code=400, detail=f"Plan inválido ({' | '.join(PLANES)})")
        _aplicar_modulos(uid, PLANES[body.plan], None)
        cobro.guardar_suscripcion({"plan": body.plan}, user_id=uid if not org_id else None, org_id=org_id)

    detalle_metodo = " · ".join(x for x in [fila.get("metodo"), fila.get("banco"),
                                            fila.get("referencia")] if x)
    # El valor de un comprobante YA INCLUYE IVA: es la plata que salió de la
    # cuenta del cliente, no una base imponible. Por eso el default acá es
    # True y no la configuración del cliente (que describe cómo se pactó el
    # precio de lista): tomarlo como neto le sumaría el 15% una segunda vez y
    # el pago quedaría asentado por más de lo que se cobró. El administrador
    # puede forzar lo contrario desde el panel si corrige el monto a neto.
    iva_incluido = True if body.iva_incluido is None else body.iva_incluido
    resultado = cobro.registrar_pago(
        user_id=None if org_id else uid,
        org_id=org_id,
        monto=monto,
        meses=meses,
        fecha=fila.get("fecha_pago"),
        metodo=fila.get("metodo"),
        nota=(body.nota or fila.get("nota") or None),
        iva_incluido=iva_incluido,
    )

    _sb().table("pagos_reportados").update({
        "estado": "aprobado",
        "revisado_por": admin_id,
        "revisado_at": datetime.now(timezone.utc).isoformat(),
        "nota_admin": (body.nota or "").strip() or None,
        "pago_id": resultado.get("pago_id"),
        "monto_aprobado": resultado.get("cobrado"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", cid).execute()

    # Sin esto el propio cliente seguiría viendo la puerta cerrada hasta dos
    # minutos después de que se le abrió (caché de acceso de access.py). Si
    # quien pagó fue la EMPRESA se limpia entero: la suscripción de la empresa
    # le abre el acceso a TODOS sus miembros, no solo a quien mandó el
    # comprobante.
    if org_id:
        invalidar_cache_rol()
    else:
        invalidar_cache_rol(uid)

    destino = fila.get("user_email") or _email_de(uid)
    if destino:
        try:
            cuerpo = (
                "¡Listo! Confirmamos tu pago y tu acceso al Gestor Tributario ya está activo.\n\n"
                f"Valor registrado: ${resultado['cobrado']:,.2f} (IVA incluido)\n"
                f"Período:          {resultado['meses']} mes(es)\n"
                f"Próximo pago:     {resultado.get('proximo_pago') or '—'}\n"
                f"{('Nota: ' + body.nota) if body.nota else ''}\n\n"
                "Ya puedes entrar a la plataforma con tu usuario de siempre.\n"
                f"Detalle del pago informado: {detalle_metodo or '—'}"
            )
            ok, err = enviar_correo(destino, "✅ Tu acceso está activo", cuerpo)
            if not ok:
                print(f"[activacion] no se pudo avisar al cliente: {err}")
        except Exception as e:
            print(f"[activacion] error avisando al cliente: {e}")

    activity.registrar(
        actor_user_id=admin_id, action="update", entity="Activación de acceso",
        module="cobros",
        metadata={"cliente": destino, "monto": resultado["cobrado"],
                  "meses": resultado["meses"], "proximo_pago": resultado.get("proximo_pago")},
    )
    # Cobrar no es lo mismo que abrir la puerta: si la cuenta sigue sin módulos,
    # el cliente pagó y va a seguir chocándose con «Sin módulos contratados».
    # Se avisa para que el administrador le asigne un plan ahora, no cuando el
    # cliente llame.
    try:
        con_modulos = bool(_sb().table("user_modules").select("modulo")
                           .eq("user_id", uid).eq("activo", True).limit(1).execute().data)
    except Exception:
        con_modulos = True
    return {"ok": True, **resultado, "sin_modulos": not con_modulos}


@router.post("/comprobantes/{cid}/rechazar")
async def rechazar(cid: str, body: RechazarIn, admin_id: str = Depends(require_admin)):
    """Devuelve el comprobante al cliente con el motivo. No toca la suscripción."""
    fila = _fila_o_404(cid)
    motivo = (body.nota or "").strip() or None
    _sb().table("pagos_reportados").update({
        "estado": "rechazado",
        "revisado_por": admin_id,
        "revisado_at": datetime.now(timezone.utc).isoformat(),
        "nota_admin": motivo,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", cid).execute()

    destino = fila.get("user_email") or _email_de(fila["user_id"])
    if destino:
        try:
            cuerpo = (
                "Recibimos el comprobante que enviaste, pero no pudimos confirmar el pago.\n\n"
                f"{('Motivo: ' + motivo) if motivo else 'Revisa los datos e inténtalo de nuevo.'}\n\n"
                "Puedes volver a enviarlo desde la plataforma, en «Mi cuenta → Mi plan»,\n"
                "o escribirnos por WhatsApp y lo revisamos juntos."
            )
            ok, err = enviar_correo(destino, "Sobre el comprobante que enviaste", cuerpo)
            if not ok:
                print(f"[activacion] no se pudo avisar al cliente: {err}")
        except Exception as e:
            print(f"[activacion] error avisando al cliente: {e}")

    activity.registrar(
        actor_user_id=admin_id, action="update", entity="Comprobante rechazado",
        module="cobros", metadata={"cliente": destino, "motivo": motivo},
    )
    return {"ok": True}
