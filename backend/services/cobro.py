# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Cobro de la suscripción: registrar un pago, activar y suspender el acceso.

Esto vivía suelto dentro de `routers/admin.py` (cobro a una persona) y de
`routers/organizations.py` (cobro a una empresa), con la misma cuenta escrita
dos veces. Al aparecer un tercer camino —el cliente reporta su pago y el
administrador lo aprueba con un botón (`routers/activacion.py`)— se sacó acá
para que la regla sea UNA:

  · el mes pagado empieza cuando se paga, no cuando debió pagarse: si la fecha
    vigente ya venció, el nuevo vencimiento se cuenta desde hoy;
  · cada "mes" son 30 días exactos;
  · el monto se guarda SIEMPRE con IVA dentro, porque es lo que se cobró.

TITULAR: la suscripción puede colgar de una EMPRESA (multiempresa, migración
056) o de una persona. Todas las funciones reciben `user_id` u `org_id`, nunca
los dos: manda la empresa si la hay, que es quien contrató.

No invalida cachés ni envía correos a propósito: de eso se ocupa quien llama,
que es el que sabe a quién hay que avisarle.
"""
from datetime import date, timedelta
from typing import Optional

from database import get_supabase_client

# Cada "mes" = 30 días exactos. Descuentos por pago anticipado.
DIAS_MES = 30
IVA = 0.15
DESCUENTOS = {1: 0.0, 3: 0.05, 6: 0.10, 12: 0.25}


def _sb():
    return get_supabase_client()


def _filtrar(q, user_id: Optional[str], org_id: Optional[str]):
    """Apunta la consulta al titular de la suscripción (empresa o persona)."""
    return q.eq("org_id", org_id) if org_id else q.eq("user_id", user_id)


def suscripcion_de(user_id: Optional[str] = None, org_id: Optional[str] = None) -> Optional[dict]:
    """Fila de `subscriptions` del titular, o None si todavía no tiene una."""
    try:
        r = _filtrar(_sb().table("subscriptions").select("*"), user_id, org_id).limit(1).execute().data
    except Exception as e:
        print(f"[cobro] no se pudo leer la suscripción: {e}")
        return None
    return r[0] if r else None


def guardar_suscripcion(datos: dict, user_id: Optional[str] = None, org_id: Optional[str] = None) -> None:
    """Crea o actualiza la suscripción del titular. Ignora los campos en None."""
    datos = {k: v for k, v in datos.items() if v is not None}
    if not datos:
        return
    datos["updated_at"] = "now()"
    sb = _sb()
    existe = _filtrar(sb.table("subscriptions").select("id"), user_id, org_id).limit(1).execute().data
    if existe:
        _filtrar(sb.table("subscriptions").update(datos), user_id, org_id).execute()
    else:
        datos.update({"org_id": org_id} if org_id else {"user_id": user_id})
        sb.table("subscriptions").insert(datos).execute()


def _base_vencimiento(actual: Optional[dict]) -> date:
    """Desde qué día se cuenta el período pagado.

    El vencimiento vigente si todavía no pasó (así quien paga antes no pierde
    los días que le quedaban), y hoy si ya venció."""
    hoy = date.today()
    if actual and actual.get("proximo_pago"):
        try:
            y, m, d = map(int, str(actual["proximo_pago"]).split("-"))
            base = date(y, m, d)
            if base > hoy:
                return base
        except ValueError:
            pass
    return hoy


def proximo_vencimiento(meses: int = 1, user_id: Optional[str] = None,
                        org_id: Optional[str] = None, actual: Optional[dict] = None) -> str:
    """Fecha del próximo pago tras abonar `meses` meses (ISO YYYY-MM-DD)."""
    if actual is None:
        actual = suscripcion_de(user_id, org_id)
    meses = max(1, int(meses or 1))
    return (_base_vencimiento(actual) + timedelta(days=DIAS_MES * meses)).isoformat()


def total_con_iva(monto: float, iva_incluido: bool) -> float:
    """Lo que efectivamente se cobró. En `pagos` el monto va SIEMPRE con IVA."""
    monto = round(float(monto or 0), 2)
    return monto if iva_incluido else round(monto * (1 + IVA), 2)


def registrar_pago(*, user_id: Optional[str] = None, org_id: Optional[str] = None,
                   monto: float, meses: int = 1, fecha: Optional[str] = None,
                   periodo: Optional[str] = None, metodo: Optional[str] = None,
                   nota: Optional[str] = None, iva_incluido: Optional[bool] = None,
                   avanzar_mes: bool = True) -> dict:
    """Asienta el pago, deja la suscripción 'activa' y corre el próximo pago.

    `iva_incluido=None` usa lo pactado con ese cliente (columna de la
    suscripción). Devuelve el id del pago, lo cobrado y el nuevo vencimiento."""
    sb = _sb()
    actual = suscripcion_de(user_id, org_id)
    meses = meses if meses in DESCUENTOS else 1
    if iva_incluido is None:
        iva_incluido = bool(actual.get("iva_incluido")) if actual else False
    cobrado = total_con_iva(monto, iva_incluido)

    fila = {
        "monto": cobrado,
        "fecha": fecha or date.today().isoformat(),
        "periodo": periodo or f"{meses} mes(es)",
        "metodo": metodo,
        "nota": nota,
    }
    fila.update({"org_id": org_id} if org_id else {"user_id": user_id})
    creado = sb.table("pagos").insert(fila).execute().data
    pago_id = (creado[0] or {}).get("id") if creado else None

    datos = {"estado": "activo"}
    if avanzar_mes:
        datos["proximo_pago"] = proximo_vencimiento(meses, actual=actual)
    guardar_suscripcion(datos, user_id, org_id)
    return {"pago_id": pago_id, "cobrado": cobrado, "meses": meses,
            "proximo_pago": datos.get("proximo_pago")}


def activar(*, user_id: Optional[str] = None, org_id: Optional[str] = None,
            meses: int = 0) -> dict:
    """Abre el acceso SIN cobrar (cortesía, prueba extendida, pago ya conciliado).

    `meses=0` solo levanta la suspensión y deja la fecha como estaba; si esa
    fecha ya venció se corre a 30 días, porque si no el acceso se volvería a
    cerrar en la siguiente petición y el botón parecería no haber hecho nada."""
    actual = suscripcion_de(user_id, org_id)
    meses = max(0, int(meses or 0))
    datos = {"estado": "activo"}
    vencida = bool(actual and actual.get("proximo_pago")
                   and str(actual["proximo_pago"]) < date.today().isoformat())
    if meses or vencida or not (actual and actual.get("proximo_pago")):
        datos["proximo_pago"] = proximo_vencimiento(meses or 1, actual=actual)
    guardar_suscripcion(datos, user_id, org_id)
    return {"estado": "activo", "proximo_pago": datos.get("proximo_pago") or (actual or {}).get("proximo_pago")}


def suspender(*, user_id: Optional[str] = None, org_id: Optional[str] = None) -> dict:
    """Cierra el acceso. No toca la fecha: al reactivar se ve dónde quedó."""
    guardar_suscripcion({"estado": "suspendido"}, user_id, org_id)
    return {"estado": "suspendido"}
