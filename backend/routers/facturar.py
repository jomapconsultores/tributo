# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Facturar a UN contribuyente con un click, en el sistema que le corresponde.

Los honorarios salen de dos lugares:
  · CMAJ          → Odoo (routers/odoo_factura.py)
  · Marco Antonio → Contabilidad MAP (services/contabilidad_map.py)

Qué sistema le factura a cada contribuyente queda guardado en
facturacion_emisor (migración 067); si nadie lo eligió, se deduce de su última
factura en Odoo. Las líneas y los valores son los mismos de la pestaña
Honorarios del mes: acá no se decide ningún precio.

Se usa desde la declaración, en el momento en que se marca presentada en el
SRI: es cuando el trabajo quedó terminado y lo que sigue es cobrarlo.
"""
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import get_current_user
from database import get_supabase_client
from routers.access import es_admin
from routers.reportes import _filas_y_total, _periodo_pedido, MESES_ES
from services import contabilidad_map
from services.activity import registrar

router = APIRouter(prefix="/api/facturar", tags=["facturar"])

EMISORES = {
    "cmaj": "CMAJ Asociados (Odoo)",
    "map": "Marco Antonio (Contabilidad MAP)",
}


def _solo_digitos(s) -> str:
    return re.sub(r"\D", "", s or "")


def _filas_de(user_id, identificacion, mes, anio):
    filas, _, _ = _filas_y_total(user_id, mes, anio)
    d = _solo_digitos(identificacion)
    return [f for f in filas if _solo_digitos(f["identificacion"]) == d]


def _resumen(filas, mes, anio):
    """Lo que se le va a cobrar este mes: solo lo marcado para cobrar y con valor."""
    cobrables = [f for f in filas if f.get("cobrar") and float(f.get("valor") or 0) > 0]
    primera = filas[0] if filas else {}
    return {
        "identificacion": primera.get("identificacion"),
        "contribuyente": primera.get("contribuyente"),
        "periodo": {"mes": mes, "anio": anio, "etiqueta": f"{MESES_ES[mes]} {anio}"},
        "emisor": primera.get("emisor", "cmaj"),
        "emisor_origen": primera.get("emisor_origen", ""),
        "emisor_nombre": EMISORES.get(primera.get("emisor", "cmaj")),
        "emisores": EMISORES,
        "map_configurado": contabilidad_map.configurado(),
        "lineas": [{
            "concepto": f["concepto"], "valor": f["valor"], "precio_oficial": f["precio_oficial"],
            "descuento": f["descuento"], "iva_incluido": f["iva_incluido"], "bruto": f["bruto"],
            "hecho": f["hecho"], "sin_presentar": f.get("sin_presentar", False),
        } for f in cobrables],
        "total": round(sum(f["bruto"] for f in cobrables), 2),
        "facturada": bool(primera.get("procesado")),
        "factura": {
            "numero": primera.get("factura_numero"),
            "fecha": primera.get("factura_fecha"),
            "autorizada": primera.get("certificada"),
            "sistema": primera.get("factura_sistema"),
        } if primera.get("procesado") else None,
    }


@router.get("/contribuyente")
async def resumen_contribuyente(identificacion: str = Query(...),
                                mes: Optional[int] = None, anio: Optional[int] = None,
                                user_id: str = Depends(get_current_user)):
    """Qué se le factura este mes a un contribuyente, desde qué sistema y si ya
    se le facturó. Sin mes/año, el mes en curso (el de la pestaña Emitir)."""
    m, a = _periodo_pedido(mes, anio)
    filas = _filas_de(user_id, identificacion, m, a)
    if not filas:
        return {"sin_honorarios": True, "identificacion": identificacion,
                "periodo": {"mes": m, "anio": a, "etiqueta": f"{MESES_ES[m]} {a}"}}
    return _resumen(filas, m, a)


class EmisorIn(BaseModel):
    identificacion: str
    emisor: str


@router.put("/emisor")
async def elegir_emisor(body: EmisorIn, user_id: str = Depends(get_current_user)):
    """Deja guardado qué sistema le factura a un contribuyente."""
    if not es_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo administradores o socios facturan.")
    if body.emisor not in EMISORES:
        raise HTTPException(status_code=400, detail="Emisor desconocido.")
    ident = (body.identificacion or "").strip()
    if not ident:
        raise HTTPException(status_code=400, detail="Falta el contribuyente.")
    try:
        get_supabase_client().table("facturacion_emisor").upsert({
            "user_id": user_id, "identificacion": ident, "emisor": body.emisor, "updated_at": "now()",
        }, on_conflict="user_id,identificacion").execute()
    except Exception as e:
        if getattr(e, "code", None) in ("42P01", "PGRST205") or "facturacion_emisor" in str(e):
            raise HTTPException(status_code=503, detail=(
                "La base todavía no guarda quién factura. Falta correr la migración "
                "067_facturacion_emisor.sql en el servidor."))
        raise
    return {"ok": True, "emisor": body.emisor}


class EmitirIn(BaseModel):
    identificacion: str
    mes: Optional[int] = None
    anio: Optional[int] = None


def _guardar_lineas(sb, user_id, filas, mes, anio):
    """Lo que se factura queda como honorario del mes: un valor arrastrado del
    mes anterior o sugerido desde Odoo no se había guardado nunca, y el cruce
    lo daba por no registrado."""
    for f in filas:
        if f.get("origen") == "manual":
            continue
        try:
            sb.table("reportes_honorarios").upsert({
                "user_id": user_id, "identificacion": f["identificacion"], "producto": f["concepto"],
                "marca": "", "cobrar": bool(f["cobrar"]), "valor": f["valor"],
                "precio_oficial": f["precio_oficial"], "descuento": f["descuento"],
                "iva_incluido": bool(f["iva_incluido"]), "mes": mes, "anio": anio, "updated_at": "now()",
            }, on_conflict="user_id,identificacion,producto,mes,anio").execute()
        except Exception as e:
            print(f"[facturar] no se guardó el honorario {f['identificacion']} {f['concepto']}: {e}")


async def _emitir_odoo(user_id, r, cobrables, mes, anio):
    from routers.odoo_factura import (FacturarBody, FacturaIn, LineaIn, IdsIn, facturar_en_odoo,
                                      estado_sri, _connect, _x, _FACT_PER_CACHE)
    # La empresa de CMAJ en Odoo (la misma que Emitir toma por defecto).
    company = None
    try:
        models, uid, db, key = _connect()
        for c in _x(models, db, uid, key, "res.company", "search_read", [[]], {"fields": ["id", "name"]}):
            if re.search(r"asociad", c.get("name") or "", re.I):
                company = c["id"]
                break
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"No se pudo conectar a Odoo: {e}")
    body = FacturarBody(company_id=company, facturas=[FacturaIn(
        ruc=r["identificacion"], nombre=r["contribuyente"] or r["identificacion"],
        iva_incluido=bool(cobrables[0]["iva_incluido"]), mes=mes, anio=anio, company_id=company,
        lineas=[LineaIn(concepto=f["concepto"], valor=f["valor"], precio_oficial=f["precio_oficial"],
                        descuento=f["descuento"]) for f in cobrables],
    )])
    res = (await facturar_en_odoo(body, user_id=user_id))["resultados"][0]
    # Que Honorarios y Emitir la vean ya, no a los dos minutos del caché.
    _FACT_PER_CACHE.clear()
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "Odoo no emitió la factura.")
    autorizacion = None
    if res.get("odoo_id"):
        # Que salga al SRI en el acto, como hace Emitir después de facturar.
        try:
            est = (await estado_sri(IdsIn(ids=[res["odoo_id"]]), user_id=user_id))["data"][0]
            autorizacion = est.get("autorizacion")
        except Exception as e:
            print(f"[facturar] verificación SRI en Odoo: {e}")
    return {"sistema": "odoo", "numero": res.get("numero"), "total": res.get("total"),
            "ya_existia": bool(res.get("ya_existia")), "autorizada": bool(autorizacion),
            "autorizacion": autorizacion, "estado": "AUTORIZADA" if autorizacion else "ENVIADA"}


def _emitir_map(user_id, r, cobrables, mes, anio):
    try:
        res = contabilidad_map.emitir(
            identificacion=r["identificacion"], nombre=r["contribuyente"],
            referencia=f"HON-{anio:04d}-{mes:02d}", etiqueta=f"{MESES_ES[mes].upper()} {anio}",
            iva_incluido=bool(cobrables[0]["iva_incluido"]),
            lineas=[{"concepto": f["concepto"], "valor": f["valor"], "precio_oficial": f["precio_oficial"],
                     "descuento": f["descuento"]} for f in cobrables])
    except contabilidad_map.ErrorMap as e:
        raise HTTPException(status_code=502, detail=str(e))
    registrar(actor_user_id=user_id, action="emit", module="facturacion",
              entity="Factura emitida en Contabilidad MAP", identificacion=r["identificacion"],
              contribuyente=r["contribuyente"],
              metadata={"numero": res.get("numero"), "total": res.get("total"), "estado": res.get("estado")})
    return {"sistema": "map", "numero": res.get("numero"), "total": res.get("total"),
            "ya_existia": bool(res.get("ya_existia")), "autorizada": res.get("estado") == "AUTORIZADA",
            "autorizacion": res.get("autorizacion"), "estado": res.get("estado"),
            "mensajes": [m.get("mensaje") for m in (res.get("mensajes") or []) if m.get("mensaje")]}


@router.post("/emitir")
async def emitir(body: EmitirIn, user_id: str = Depends(get_current_user)):
    """Emite la factura de honorarios del mes de un contribuyente en su sistema.
    Volver a tocarlo no duplica: los dos sistemas reconocen el mes (HON-AAAA-MM)."""
    if not es_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo administradores o socios facturan.")
    mes, anio = _periodo_pedido(body.mes, body.anio)
    filas = _filas_de(user_id, body.identificacion, mes, anio)
    if not filas:
        raise HTTPException(status_code=404, detail=(
            "Este contribuyente no tiene honorarios en Facturación (ningún servicio activo)."))
    r = _resumen(filas, mes, anio)
    cobrables = [f for f in filas if f.get("cobrar") and float(f.get("valor") or 0) > 0]
    if not cobrables:
        raise HTTPException(status_code=400, detail=(
            f"No hay valor a cobrar para {MESES_ES[mes]} {anio}. Cárgalo en Facturación › Honorarios."))
    if r["facturada"]:
        return {"ok": True, "ya_existia": True, **(r["factura"] or {})}

    _guardar_lineas(get_supabase_client(), user_id, cobrables, mes, anio)
    if r["emisor"] == "map":
        out = _emitir_map(user_id, r, cobrables, mes, anio)
    else:
        out = await _emitir_odoo(user_id, r, cobrables, mes, anio)
    return {"ok": True, "emisor": r["emisor"], "emisor_nombre": EMISORES[r["emisor"]], **out}
