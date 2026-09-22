# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Facturación de honorarios en Contabilidad MAP (lo que cobra Marco Antonio).

Lo de CMAJ se factura en Odoo (routers/odoo_factura.py); lo de Marco Antonio,
en su propio sistema contable, que firma y envía al SRI por su cuenta. Este
módulo le habla a su entrada de integración (/api/integracion/facturas), que se
protege con un token compartido:

  MAP_URL          https://map.pensamiento-libre.org
  MAP_TOKEN        el mismo valor que INTEGRACION_TOKEN en Contabilidad MAP
  MAP_ENTIDAD_RUC  RUC de la entidad emisora (opcional si MAP ya fija una)

El mes que cubre cada factura viaja como referencia HON-AAAA-MM, igual que en
Odoo: así se sabe a quién ya se le facturó el mes y reenviar no duplica.
"""
import os
import re
import time

import requests

_TIMEOUT_EMITIR = 150   # recepción + autorización del SRI, con esperas entre medias
_TIMEOUT_LEER = 20
_CACHE = {}             # referencia -> (timestamp, {ruc_digitos: factura})
_TTL = 120


class ErrorMap(Exception):
    pass


def _cfg():
    url = (os.getenv("MAP_URL") or "https://map.pensamiento-libre.org").rstrip("/")
    token = os.getenv("MAP_TOKEN") or ""
    return url, token, (os.getenv("MAP_ENTIDAD_RUC") or "").strip()


def configurado() -> bool:
    return bool(_cfg()[1])


def _solo_digitos(s) -> str:
    return re.sub(r"\D", "", s or "")


def _llamar(metodo, params=None, cuerpo=None, timeout=_TIMEOUT_LEER):
    url, token, entidad = _cfg()
    if not token:
        raise ErrorMap("Contabilidad MAP no está configurada en el servidor (falta MAP_TOKEN).")
    if entidad:
        if params is not None:
            params = {**params, "entidad_ruc": entidad}
        if cuerpo is not None:
            cuerpo = {**cuerpo, "entidad_ruc": entidad}
    try:
        r = requests.request(metodo, f"{url}/api/integracion/facturas", params=params, json=cuerpo,
                             headers={"Authorization": f"Bearer {token}"}, timeout=timeout)
    except requests.RequestException as e:
        raise ErrorMap(f"No se pudo conectar con Contabilidad MAP: {e}")
    try:
        data = r.json()
    except ValueError:
        raise ErrorMap(f"Contabilidad MAP respondió {r.status_code} sin datos legibles.")
    if not data.get("ok"):
        raise ErrorMap(data.get("error") or f"Contabilidad MAP respondió {r.status_code}.")
    return data.get("datos")


def facturas_de_referencia(referencia: str) -> dict:
    """{ruc(dígitos): factura} emitidas en MAP para ese mes (HON-AAAA-MM).
    Tolerante a fallos: sin configuración o sin conexión devuelve {}."""
    if not configurado():
        return {}
    c = _CACHE.get(referencia)
    if c and (time.time() - c[0]) < _TTL:
        return c[1]
    out = {}
    try:
        for v in _llamar("GET", params={"referencia": referencia}) or []:
            d = _solo_digitos(v.get("id_cliente"))
            if d and d not in out:   # vienen de la más reciente a la más vieja
                out[d] = {
                    "numero": v.get("numero"),
                    "fecha": v.get("fecha"),
                    "total": float(v.get("total") or 0),
                    "autorizada": v.get("sri_estado") == "AUTORIZADA",
                    "autorizacion": v.get("autorizacion"),
                    "sistema": "map",
                }
    except ErrorMap as e:
        print(f"[map] facturas_de_referencia: {e}")
        return {}
    _CACHE[referencia] = (time.time(), out)
    return out


def _tipo_id(ident: str) -> str:
    d = _solo_digitos(ident)
    if len(d) == 13:
        return "RUC"
    if len(d) == 10:
        return "CEDULA"
    return "PASAPORTE"


def emitir(*, identificacion, nombre, referencia, etiqueta, lineas, iva_incluido=False, email=None):
    """Emite en MAP la factura de honorarios. `lineas` = [{concepto, valor,
    precio_oficial, descuento}] como las de Odoo (valor = neto; descuento en %).
    Devuelve lo que contesta MAP: numero, estado (AUTORIZADA, RECIBIDA…),
    autorizacion, total, ya_existia, mensajes."""
    items = []
    for ln in lineas:
        oficial = float(ln.get("precio_oficial") or 0)
        neto = float(ln.get("valor") or 0)
        pct = float(ln.get("descuento") or 0)
        if iva_incluido:   # los montos traen el IVA: el comprobante va sobre la base
            oficial = round(oficial / 1.15, 2)
            neto = round(neto / 1.15, 2)
        if oficial > 0 and pct > 0:
            precio, descuento = oficial, round(oficial * pct / 100.0, 2)
        else:
            precio, descuento = neto, 0.0
        descripcion = f"{ln.get('concepto')} — {etiqueta}" if etiqueta else ln.get("concepto")
        items.append({"descripcion": descripcion[:300], "precio_unitario": round(precio, 2),
                      "descuento": descuento})
    datos = _llamar("POST", cuerpo={
        "referencia": referencia,
        "tipo_id_cliente": _tipo_id(identificacion),
        "id_cliente": _solo_digitos(identificacion) or identificacion,
        "razon_social_cliente": (nombre or identificacion)[:300],
        "email_cliente": email or None,
        "concepto": f"Honorarios {etiqueta}".strip(),
        "items": items,
    }, timeout=_TIMEOUT_EMITIR)
    _CACHE.pop(referencia, None)
    return datos or {}
