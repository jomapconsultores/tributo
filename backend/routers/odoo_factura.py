"""Integración con Odoo 19: crea y confirma facturas de venta desde honorarios.

Credenciales Odoo desde variables de entorno (nunca hardcodeadas):
  ODOO_URL        https://cmaj-asociados-sas.odoo.com
  ODOO_DB         cmaj-asociados-sas
  ODOO_USERNAME   jomapconsultores@outlook.com
  ODOO_API_KEY    (api key de Odoo)
"""
import os
import re
import time
import threading
import xmlrpc.client
from datetime import datetime, timezone, timedelta

_EC_TZ_ODOO = timezone(timedelta(hours=-5))  # Ecuador (UTC-5), para el mes en curso
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from auth import get_current_user
from routers.access import es_admin, es_super_admin, rol_de
from database import get_supabase_client, fetch_all
from tenancy import shared_client_ids
from services.activity import registrar, _email_de
from services.email_sender import enviar_correo, email_configurado

router = APIRouter(prefix="/api/odoo", tags=["odoo"])

IVA_RATE = 0.15

# Destino del aviso de facturación (la responsable de facturación en Odoo).
ODOO_NOTIFY_EMAIL = os.getenv("ODOO_NOTIFY_EMAIL", "johannanievecela@hotmail.com")
# Empresa EMISORA que NO genera recordatorio de cobro (se excluye por nombre).
EXCLUIR_EMISOR = os.getenv("ODOO_EXCLUIR_EMISOR", "marco antonio").strip().lower()
# Token para que el cron semanal pueda llamar al recordatorio sin sesión.
_CRON_DEFAULT = os.getenv("CRON_SECRET", "jomap-cobros-semanal-2026")


def _idents_autorizadas(sb, user_id: str) -> set:
    """RUCs/cédulas de los contribuyentes que el usuario puede facturar:
    los propios + los compartidos por el administrador."""
    idents = set()
    for c in fetch_all(lambda: sb.table("clients").select("identificacion").eq("user_id", user_id)):
        if c.get("identificacion"):
            idents.add(c["identificacion"])
    sids = shared_client_ids(user_id)
    if sids:
        for c in fetch_all(lambda: sb.table("clients").select("identificacion").in_("id", sids)):
            if c.get("identificacion"):
                idents.add(c["identificacion"])
    return idents


def _notificar_johanna(*, actor_user_id: str, exitosas: list):
    """Avisa por correo a la responsable de facturación (Johanna) para que gestione
    el COBRO de las facturas emitidas. Corre en hilo aparte. Se avisa siempre,
    salvo si quien emite es la propia destinataria (no se auto-notifica)."""
    destino = (ODOO_NOTIFY_EMAIL or "").strip()
    if not destino or not email_configurado():
        return
    actor = _email_de(actor_user_id) or "Un usuario"
    if actor and actor.strip().lower() == destino.lower():
        return  # quien emite es la propia Johanna: no auto-notificar
    lineas, total = [], 0.0
    for r in exitosas:
        t = float(r.get("total") or 0)
        total += t
        lineas.append(f"  - {r.get('nombre')} ({r.get('ruc')}): {r.get('numero') or 's/n'}  ${t:,.2f}")
    cuerpo = (
        f"Johanna, se emitieron {len(exitosas)} factura(s) en Odoo (por {actor}). "
        "Por favor gestiona el COBRO de estos valores:\n\n"
        + "\n".join(lineas)
        + f"\n\nTotal a cobrar: ${total:,.2f}\n\nGracias."
    )
    try:
        enviar_correo(destino, f"Cobro pendiente — {len(exitosas)} factura(s) emitida(s) en Odoo", cuerpo)
    except Exception as e:
        print(f"[odoo] fallo aviso a {destino}: {e}")


# ---------------------------------------------------------------------------
# Helpers de conexión
# ---------------------------------------------------------------------------

# Valores por defecto de Odoo (PROVISIONAL, a pedido del cliente — opción B).
# Las env vars del servidor, si existen, SIEMPRE tienen prioridad sobre estos.
# Recomendado: regenerar la API key en Odoo y moverla a una env var secreta.
_ODOO_DEFAULTS = {
    "ODOO_URL": "https://cmaj-asociados-sas.odoo.com",
    "ODOO_DB": "cmaj-asociados-sas",
    "ODOO_USERNAME": "jomapconsultores@outlook.com",
    "ODOO_API_KEY": "e56f2003a8b2c3fe0a408c08042432087e0090ea",
}


def _cfg():
    url = (os.getenv("ODOO_URL") or _ODOO_DEFAULTS["ODOO_URL"]).rstrip("/")
    db = os.getenv("ODOO_DB") or _ODOO_DEFAULTS["ODOO_DB"]
    user = os.getenv("ODOO_USERNAME") or _ODOO_DEFAULTS["ODOO_USERNAME"]
    key = os.getenv("ODOO_API_KEY") or _ODOO_DEFAULTS["ODOO_API_KEY"]
    if not all([url, db, user, key]):
        raise HTTPException(status_code=503,
                            detail="Odoo no configurado en el servidor (env vars faltantes)")
    return url, db, user, key


def _connect():
    url, db, user, key = _cfg()
    try:
        common = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common", allow_none=True)
        uid = common.authenticate(db, user, key, {})
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"No se pudo conectar a Odoo: {e}")
    if not uid:
        raise HTTPException(status_code=503,
                            detail="Autenticación Odoo fallida — verifique credenciales")
    models = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object", allow_none=True)
    return models, uid, db, key


def _x(models, db, uid, key, model, method, args, kw=None):
    """Wrapper de execute_kw."""
    return models.execute_kw(db, uid, key, model, method, args, kw or {})


# ---------------------------------------------------------------------------
# Find-or-create de entidades Odoo
# ---------------------------------------------------------------------------

def _buscar_partner_id(models, db, uid, key, ruc):
    """Busca el cliente por RUC tolerando el formato del vat en Odoo: RUC de 13
    dígitos, cédula de 10 (sin el '001'), o cédula → RUC. None si no existe."""
    dig = _solo_digitos(ruc)
    cand = [ruc, dig]
    if len(dig) == 13 and dig.endswith("001"):
        cand.append(dig[:10])      # cédula sin el 001
    if len(dig) == 10:
        cand.append(dig + "001")   # cédula → RUC
    for v in dict.fromkeys([c for c in cand if c]):
        ids = _x(models, db, uid, key, "res.partner", "search", [[["vat", "=", v]]], {"limit": 1})
        if ids:
            return ids[0]
    return None


_EC_CACHE = {}  # ids de país/tipos de identificación de Ecuador (se cachean)


def _ec_ids(models, db, uid, key):
    """(country_id Ecuador, tipo RUC, tipo Cédula, tipo VAT genérico). Cacheado."""
    if _EC_CACHE:
        return _EC_CACHE.get("c"), _EC_CACHE.get("ruc"), _EC_CACHE.get("ced"), _EC_CACHE.get("vat")
    c = ruc = ced = vat = None
    try:
        ecs = _x(models, db, uid, key, "res.country", "search", [[["code", "=", "EC"]]], {"limit": 1})
        c = ecs[0] if ecs else None
        tipos = _x(models, db, uid, key, "l10n_latam.identification.type", "search_read",
                   [[]], {"fields": ["id", "name", "country_id"]})
        for t in tipos:
            n = (t.get("name") or "").lower()
            tc = (t.get("country_id") or [0])[0]
            if tc == c and ("ruc" in n):
                ruc = t["id"]
            elif tc == c and ("cedula" in n or "cédula" in n or "citizen" in n or "ciudadan" in n):
                ced = t["id"]
            elif not t.get("country_id") and n == "vat":
                vat = t["id"]
    except Exception as e:
        print(f"[odoo] _ec_ids: {e}")
    _EC_CACHE.update({"c": c, "ruc": ruc, "ced": ced, "vat": vat})
    return c, ruc, ced, vat


def _datos_partner_ec(ruc, nombre, country_id, t_ruc, t_ced):
    """Datos pertinentes para crear el cliente en Odoo (Ecuador): país, tipo de
    identificación (RUC 13 díg. / Cédula 10), persona o empresa."""
    dig = _solo_digitos(ruc)
    es_empresa = len(dig) == 13 and dig[2:3] in ("6", "9")
    vals = {"name": (nombre or "").strip(), "vat": ruc, "is_company": es_empresa, "customer_rank": 1}
    if country_id:
        vals["country_id"] = country_id
    tipo = t_ruc if len(dig) == 13 else (t_ced if len(dig) == 10 else None)
    if tipo:
        vals["l10n_latam_identification_type_id"] = tipo
    return vals


def _asegurar_partner_ec(models, db, uid, key, partner_id, ruc):
    """Completa país y tipo de identificación si al cliente le faltan (para que la
    factura sea válida en el SRI). No duplica: actualiza el existente."""
    c, t_ruc, t_ced, t_vat = _ec_ids(models, db, uid, key)
    try:
        cur = _x(models, db, uid, key, "res.partner", "read", [[partner_id]],
                 {"fields": ["country_id", "l10n_latam_identification_type_id"]})[0]
    except Exception:
        return
    upd = {}
    if not cur.get("country_id") and c:
        upd["country_id"] = c
    dig = _solo_digitos(ruc)
    tipo = t_ruc if len(dig) == 13 else (t_ced if len(dig) == 10 else None)
    actual_tipo = (cur.get("l10n_latam_identification_type_id") or [None])[0]
    if tipo and (not actual_tipo or actual_tipo == t_vat):
        upd["l10n_latam_identification_type_id"] = tipo
    if upd:
        try:
            _x(models, db, uid, key, "res.partner", "write", [[partner_id], upd])
        except Exception as e:
            print(f"[odoo] no se pudo completar país/tipo del cliente {ruc}: {e}")


def _find_or_create_partner(models, db, uid, key, ruc: str, nombre: str) -> int:
    pid = _buscar_partner_id(models, db, uid, key, ruc)
    if pid:
        _asegurar_partner_ec(models, db, uid, key, pid, ruc)  # completa país/tipo si faltan
        return pid
    c, t_ruc, t_ced, _ = _ec_ids(models, db, uid, key)
    return _x(models, db, uid, key, "res.partner", "create", [_datos_partner_ec(ruc, nombre, c, t_ruc, t_ced)])


def _find_or_create_product(models, db, uid, key, nombre: str) -> int:
    ids = _x(models, db, uid, key, "product.product", "search",
             [[["name", "=ilike", nombre], ["type", "=", "service"]]], {"limit": 1})
    if ids:
        return ids[0]
    return _x(models, db, uid, key, "product.product", "create", [{
        "name": nombre,
        "type": "service",
        "invoice_policy": "order",
    }])


# ---------------------------------------------------------------------------
# Valor a cobrar por cliente (desde Odoo) — para prellenar Reportes
# ---------------------------------------------------------------------------

_HON_CACHE = {}      # cache_key -> (timestamp, {ruc_digitos: [líneas]})
_HON_TTL = 120       # segundos


def _solo_digitos(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def valores_honorarios_por_ruc(idents: set, cache_key=None) -> dict:
    """Devuelve {ruc(dígitos): [ línea, ... ]} con TODAS las líneas de servicio
    distintas facturadas a cada cliente en Odoo, referenciado por RUC (vat), más
    recientes primero y sin repetir concepto. Cada línea trae:
      concepto, oficial (price_unit = PRECIO OFICIAL), descuento (% por línea),
      neto (precio_unit con el descuento aplicado, POR UNIDAD), numero, fecha.
    Se usa el PRECIO UNITARIO (no el subtotal) porque la cantidad puede ser > 1
    (varios meses en una factura). Reportes elige, por cada concepto, la línea de
    MAYOR RELACIÓN. Tolerante a fallos: si Odoo no responde devuelve {}."""
    if cache_key:
        c = _HON_CACHE.get(cache_key)
        if c and (time.time() - c[0]) < _HON_TTL:
            return c[1]
    norm = {_solo_digitos(i) for i in idents if i}
    out = {}
    try:
        models, uid, db, key = _connect()
        dom = [["move_type", "=", "out_invoice"], ["state", "=", "posted"]]
        ids = _x(models, db, uid, key, "account.move", "search", [dom],
                 {"order": "invoice_date desc, id desc", "limit": 3000})
        rows = _x(models, db, uid, key, "account.move", "read", [ids],
                  {"fields": ["partner_id", "amount_untaxed", "invoice_date", "name", "invoice_line_ids"]}) if ids else []
        pids = list({r["partner_id"][0] for r in rows if r.get("partner_id")})
        vat = {}
        if pids:
            for p in _x(models, db, uid, key, "res.partner", "read", [pids], {"fields": ["id", "vat"]}):
                vat[p["id"]] = _solo_digitos(p.get("vat") or "")
        # Solo facturas de clientes del programa (reduce mucho la lectura de líneas).
        porruc = {}
        for r in rows:
            v = vat.get((r.get("partner_id") or [None])[0], "")
            if v and v in norm:
                porruc.setdefault(v, []).append(r)   # ya vienen por fecha desc
        line_ids = [lid for fs in porruc.values() for r in fs for lid in (r.get("invoice_line_ids") or [])]
        lmap = {}
        for i in range(0, len(line_ids), 500):
            for l in _x(models, db, uid, key, "account.move.line", "read",
                        [line_ids[i:i + 500]], {"fields": ["id", "name", "product_id", "price_unit", "discount", "price_subtotal"]}):
                lmap[l["id"]] = l

        def _lineas(r):
            res = []
            for lid in (r.get("invoice_line_ids") or []):
                l = lmap.get(lid)
                if not l:
                    continue
                pn = l["product_id"][1] if l.get("product_id") else (l.get("name") or "")
                oficial = float(l.get("price_unit") or 0)
                desc = float(l.get("discount") or 0)
                neto = round(oficial * (1 - desc / 100.0), 2)  # precio UNITARIO con descuento
                res.append((pn, oficial, desc, neto))
            return res

        for v, fs in porruc.items():
            lineas, vistos = [], set()
            for r in fs:  # facturas por fecha desc
                for pn, oficial, desc, neto in _lineas(r):
                    clave = re.sub(r"[^a-z0-9]", "", (pn or "").lower())
                    if not pn or neto <= 0 or clave in vistos:
                        continue
                    vistos.add(clave)
                    lineas.append({"concepto": pn, "oficial": round(oficial, 2),
                                   "descuento": round(desc, 2), "neto": neto,
                                   "numero": r.get("name"), "fecha": r.get("invoice_date")})
            if lineas:
                out[v] = lineas
    except Exception as e:
        print(f"[odoo] valores_honorarios_por_ruc: {e}")
        out = {}
    if cache_key and out:
        _HON_CACHE[cache_key] = (time.time(), out)
    return out


# ---------------------------------------------------------------------------
# Cuentas contables: cuenta por cobrar individual del cliente + bancos
# ---------------------------------------------------------------------------

def _tok_nombre(s: str) -> set:
    import unicodedata
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return {t for t in re.findall(r"[a-z]+", s) if len(t) > 2}


def _match_cuenta_cobrar(nombre_cliente: str, cuentas: list):
    """Cuenta 'Cuentas por cobrar <NOMBRE>' cuyo nombre esté contenido en el del
    cliente (mejor match = más tokens). None si ninguna coincide."""
    cli = _tok_nombre(nombre_cliente)
    if not cli:
        return None
    best, best_sc = None, 0
    for a in cuentas:
        an = re.sub(r"(?i)cuentas?\s+por\s+cobrar", "", a.get("name") or "")
        toks = _tok_nombre(an)
        if toks and toks <= cli and len(toks) > best_sc:
            best, best_sc = a, len(toks)
    return best


def _ctx_emp(company_id):
    """Contexto para trabajar en el plan de cuentas de una compañía concreta
    (los códigos de cuenta y las cuentas por cobrar son por compañía)."""
    if not company_id:
        return {}
    cid = int(company_id)
    return {"allowed_company_ids": [cid], "company_id": cid}


def _cuentas_cobrar_emp(models, db, uid, key, company_id):
    """Cuentas por cobrar (asset_receivable) del plan de la compañía dada, con su
    código leído en el contexto de esa compañía."""
    return _x(models, db, uid, key, "account.account", "search_read",
              [[["account_type", "=", "asset_receivable"]]],
              {"fields": ["id", "code", "name"], "context": _ctx_emp(company_id)})


def _siguiente_codigo_cobrar(accts):
    """Siguiente código de la serie de cuentas por cobrar individuales de la
    compañía: max(individuales)+1; si no hay, deriva de la cuenta genérica
    (la de código más corto) con sufijo '01'. None si no hay plan por cobrar."""
    indiv = [str(a["code"]) for a in accts
             if a.get("code") and "cuentas por cobrar" in (a.get("name") or "").lower() and str(a["code"]).isdigit()]
    if indiv:
        return str(max(int(c) for c in indiv) + 1)
    codes = [str(a["code"]) for a in accts if a.get("code") and str(a["code"]).isdigit()]
    if codes:
        return min(codes, key=len) + "01"
    return None


def _iva_15_s_id(models, db, uid, key, company_id):
    """ID del impuesto de venta 'IVA 15% (411, S)' (Odoo lo llama 'VAT 15% S') de
    la compañía. Es el de servicios/honorarios. None si la empresa no lo tiene."""
    ts = _x(models, db, uid, key, "account.tax", "search_read",
            [[["type_tax_use", "=", "sale"], ["amount", "=", 15]]],
            {"fields": ["id", "name"], "context": _ctx_emp(company_id)})
    for t in ts:
        if re.search(r"15\s*%?\s*s\b", t.get("name") or "", re.I):
            return t["id"]
    return None


def _registrar_pago(models, db, uid, key, inv_id: int, journal_id: int):
    """Registra el cobro de una factura posteada en el diario de banco indicado
    (account.payment.register). La factura queda PAGADA y el dinero entra al banco."""
    ctx = {"active_model": "account.move", "active_ids": [inv_id]}
    wiz = _x(models, db, uid, key, "account.payment.register", "create",
             [{"journal_id": journal_id}], {"context": ctx})
    _x(models, db, uid, key, "account.payment.register", "action_create_payments",
       [[wiz]], {"context": ctx})


# ---------------------------------------------------------------------------
# Modelos Pydantic
# ---------------------------------------------------------------------------

class LineaIn(BaseModel):
    concepto: str
    valor: float                          # NETO de la línea (base sin IVA si iva_incluido=False)
    precio_oficial: Optional[float] = None  # precio de lista → price_unit en Odoo
    descuento: Optional[float] = 0        # % de descuento → discount en Odoo
    product_id: Optional[int] = None      # producto Odoo a usar (si se eligió uno)
    producto_nombre: Optional[str] = None  # nombre del producto a buscar/crear (lo tecleado)


class FacturaIn(BaseModel):
    ruc: str
    nombre: str
    lineas: List[LineaIn]
    iva_incluido: bool = False
    company_id: Optional[int] = None   # empresa EMISORA de ESTA factura (override del global)
    cuenta_cobrar_id: Optional[int] = None  # cuenta por cobrar a asignar al cliente (registro contable)
    banco_journal_id: Optional[int] = None  # si se setea, se registra el cobro en ese banco (queda PAGADA)


class FacturarBody(BaseModel):
    facturas: List[FacturaIn]
    company_id: Optional[int] = None   # empresa EMISORA por defecto (si la factura no trae una)


class ClienteRef(BaseModel):
    ruc: str
    nombre: str
    company_id: Optional[int] = None   # empresa EMISORA (su plan de cuentas)


class CuentasClientesIn(BaseModel):
    clientes: List[ClienteRef]


class CrearCuentaIn(BaseModel):
    ruc: str
    nombre: str
    company_id: Optional[int] = None   # empresa donde se crea la cuenta
    codigo: Optional[str] = None       # código a usar (si no, el siguiente de la serie)


class CrearClienteIn(BaseModel):
    ruc: str
    nombre: str


class IdsIn(BaseModel):
    ids: List[int]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/estado")
async def odoo_estado(user_id: str = Depends(get_current_user)):
    """Verifica que Odoo esté configurado y accesible (cualquier usuario autenticado)."""
    try:
        url, db, user, key = _cfg()
        common = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common", allow_none=True)
        uid = common.authenticate(db, user, key, {})
        return {"ok": bool(uid), "uid": uid, "url": url, "db": db}
    except HTTPException:
        raise
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/empresas")
async def odoo_empresas(user_id: str = Depends(get_current_user)):
    """Empresas (compañías) en Odoo — la empresa EMISORA que factura al cliente."""
    try:
        models, uid, db, key = _connect()
        ids = _x(models, db, uid, key, "res.company", "search", [[]])
        rows = _x(models, db, uid, key, "res.company", "read", [ids], {"fields": ["id", "name"]})
        return {"data": rows}
    except HTTPException:
        raise
    except Exception as e:
        return {"data": [], "error": str(e)}


@router.get("/productos")
async def odoo_productos(user_id: str = Depends(get_current_user), q: Optional[str] = None):
    """Productos/servicios que ya existen en Odoo (para mapear los conceptos a cobrar)."""
    try:
        models, uid, db, key = _connect()
        domain = [["type", "=", "service"]]
        if q:
            domain.append(["name", "ilike", q])
        ids = _x(models, db, uid, key, "product.product", "search", [domain], {"limit": 300})
        rows = _x(models, db, uid, key, "product.product", "read", [ids], {"fields": ["id", "name"]})
        rows.sort(key=lambda p: (p.get("name") or "").upper())
        return {"data": rows}
    except HTTPException:
        raise
    except Exception as e:
        return {"data": [], "error": str(e)}


@router.get("/cuentas")
async def odoo_cuentas(company_id: Optional[int] = None, user_id: str = Depends(get_current_user)):
    """Diarios de banco/efectivo de la empresa emisora (para el cobro directo) y
    si la empresa tiene el impuesto IVA 15% (411, S). Todo por compañía."""
    try:
        models, uid, db, key = _connect()
        bancos = _x(models, db, uid, key, "account.journal", "search_read",
                    [[["type", "in", ["bank", "cash"]]]],
                    {"fields": ["id", "name", "type"], "context": _ctx_emp(company_id)})
        tax_id = _iva_15_s_id(models, db, uid, key, company_id) if company_id else None
        return {"bancos": bancos, "iva_15_s": bool(tax_id)}
    except HTTPException:
        raise
    except Exception as e:
        return {"bancos": [], "iva_15_s": True, "error": str(e)}


@router.post("/cuentas-cobrar")
async def odoo_cuentas_cobrar(body: CuentasClientesIn, user_id: str = Depends(get_current_user)):
    """Por cada cliente busca su cuenta por cobrar individual EN EL PLAN DE CUENTAS
    de su empresa emisora (company_id). Si no existe, devuelve el SIGUIENTE código
    que le tocaría. Devuelve {ruc: {...}}."""
    try:
        models, uid, db, key = _connect()
    except HTTPException as e:
        return {"data": {}, "error": e.detail}
    cache = {}   # company_id -> cuentas por cobrar de esa compañía
    out = {}
    for c in body.clientes:
        cid = c.company_id
        if cid not in cache:
            cache[cid] = _cuentas_cobrar_emp(models, db, uid, key, cid) if cid else []
        accts = cache[cid]
        cta = _match_cuenta_cobrar(c.nombre, accts)
        partner_id = _buscar_partner_id(models, db, uid, key, c.ruc)
        asignada = False
        if partner_id and cta:
            p = _x(models, db, uid, key, "res.partner", "read", [[partner_id]],
                   {"fields": ["property_account_receivable_id"], "context": _ctx_emp(cid)})
            asignada = bool(p) and (p[0].get("property_account_receivable_id") or [0])[0] == cta["id"]
        # Última factura emitida a este cliente por esta empresa (para detectar si ya
        # se emitió y su estado en el SRI).
        ultima = None
        if partner_id:
            dom = [["move_type", "=", "out_invoice"], ["partner_id", "=", partner_id], ["state", "=", "posted"]]
            if cid:
                dom.append(["company_id", "=", cid])
            inv = _x(models, db, uid, key, "account.move", "search", [dom],
                     {"order": "invoice_date desc, id desc", "limit": 1, "context": _ctx_emp(cid)})
            if inv:
                m = _x(models, db, uid, key, "account.move", "read", [inv],
                       {"fields": ["name", "invoice_date", "edi_state", "l10n_ec_authorization_number"],
                        "context": _ctx_emp(cid)})[0]
                ultima = {"numero": m.get("name"), "fecha": m.get("invoice_date"),
                          "edi_state": m.get("edi_state"),
                          "autorizada": bool(m.get("l10n_ec_authorization_number"))}
        out[c.ruc] = {
            "company_id": cid,
            "partner_id": partner_id,
            "existe": bool(cta),
            "cuenta_id": cta["id"] if cta else None,
            "cuenta_codigo": cta["code"] if cta else None,
            "cuenta_nombre": cta["name"] if cta else None,
            "asignada": asignada,
            "siguiente_codigo": None if cta else _siguiente_codigo_cobrar(accts),
            "ultima_factura": ultima,
        }
    return {"data": out}


@router.post("/crear-cuenta-cobrar")
async def crear_cuenta_cobrar(body: CrearCuentaIn, user_id: str = Depends(get_current_user)):
    """Crea 'Cuentas por cobrar <NOMBRE>' en el plan de la empresa (company_id) con
    el código indicado (o el siguiente de la serie) y la asigna al cliente."""
    try:
        models, uid, db, key = _connect()
        cid = body.company_id
        ctx = _ctx_emp(cid)
        accts = _cuentas_cobrar_emp(models, db, uid, key, cid) if cid else []
        codigo = (body.codigo or "").strip() or _siguiente_codigo_cobrar(accts)
        if not codigo:
            raise HTTPException(status_code=400,
                                detail="La empresa emisora no tiene plan de cuentas por cobrar configurado en Odoo.")
        nombre = (body.nombre or "").strip().upper()
        nombre_cta = f"Cuentas por cobrar {nombre}"
        new_id = _x(models, db, uid, key, "account.account", "create",
                    [{"code": codigo, "name": nombre_cta, "account_type": "asset_receivable"}], {"context": ctx})
        pids = _x(models, db, uid, key, "res.partner", "search", [[["vat", "=", body.ruc]]], {"limit": 1}) or \
            _x(models, db, uid, key, "res.partner", "search", [[["vat", "=", _solo_digitos(body.ruc)]]], {"limit": 1})
        if pids:
            _x(models, db, uid, key, "res.partner", "write",
               [[pids[0]], {"property_account_receivable_id": new_id}], {"context": ctx})
        return {"ok": True, "cuenta_id": new_id, "cuenta_codigo": codigo, "cuenta_nombre": nombre_cta}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"No se pudo crear la cuenta: {e}")


@router.post("/crear-cliente")
async def crear_cliente(body: CrearClienteIn, user_id: str = Depends(get_current_user)):
    """Crea el cliente (res.partner) en Odoo con los datos pertinentes (nombre, RUC,
    tipo). Si ya existe (por RUC), lo devuelve. Sugerencia: persona/empresa según el
    3er dígito del RUC (6/9 = sociedad/público)."""
    try:
        models, uid, db, key = _connect()
        ruc = (body.ruc or "").strip()
        existe = _buscar_partner_id(models, db, uid, key, ruc)
        if existe:
            _asegurar_partner_ec(models, db, uid, key, existe, ruc)  # completa país/tipo si faltan
            return {"ok": True, "partner_id": existe, "ya_existia": True}
        c, t_ruc, t_ced, _ = _ec_ids(models, db, uid, key)
        pid = _x(models, db, uid, key, "res.partner", "create",
                 [_datos_partner_ec(ruc, body.nombre, c, t_ruc, t_ced)])
        return {"ok": True, "partner_id": pid, "ya_existia": False}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"No se pudo crear el cliente: {e}")


@router.post("/estado-sri")
async def estado_sri(body: IdsIn, user_id: str = Depends(get_current_user)):
    """Verifica el envío al SRI de las facturas (número de autorización / edi_state)
    y, si alguna no se autorizó, reintenta el envío. Devuelve el estado por factura."""
    try:
        models, uid, db, key = _connect()
    except HTTPException as e:
        return {"data": [], "error": e.detail}
    try:
        comp_ids = _x(models, db, uid, key, "res.company", "search", [[]])
    except Exception:
        comp_ids = []
    ctx = {"allowed_company_ids": comp_ids} if comp_ids else {}
    campos = ["name", "state", "edi_state", "l10n_ec_authorization_number"]
    out = []
    for mid in body.ids:
        try:
            data = _x(models, db, uid, key, "account.move", "read", [[mid]], {"fields": campos, "context": ctx})
            if not data:
                out.append({"id": mid, "error": "no existe"})
                continue
            m = data[0]
            # Reintentar el envío al SRI si está posteada pero aún no autorizada.
            if m.get("state") == "posted" and m.get("edi_state") not in ("sent",):
                try:
                    _x(models, db, uid, key, "account.move", "action_process_edi_web_services", [[mid]], {"context": ctx})
                except Exception:
                    pass  # la acción puede correr aunque el retorno no serialice
                try:
                    m = _x(models, db, uid, key, "account.move", "read", [[mid]], {"fields": campos, "context": ctx})[0]
                except Exception:
                    pass
            out.append({
                "id": mid,
                "numero": m.get("name"),
                "estado": m.get("state"),
                "edi_state": m.get("edi_state"),
                "autorizacion": m.get("l10n_ec_authorization_number") or None,
            })
        except Exception as e:
            out.append({"id": mid, "error": str(e)[:120]})
    return {"data": out}


@router.get("/facturas")
async def odoo_facturas(user_id: str = Depends(get_current_user)):
    """Facturas de venta (honorarios) emitidas/posteadas en Odoo, para el submenú
    'Facturas procesadas' (con búsqueda por fecha/RUC/nombre). Las más recientes."""
    try:
        models, uid, db, key = _connect()
    except Exception:
        return {"data": []}
    try:
        comp = _x(models, db, uid, key, "res.company", "search", [[]])
    except Exception:
        comp = []
    ctx = {"allowed_company_ids": comp} if comp else {}
    dom = [["move_type", "=", "out_invoice"], ["state", "=", "posted"]]
    ids = _x(models, db, uid, key, "account.move", "search", [dom],
             {"order": "invoice_date desc, id desc", "limit": 800, "context": ctx})
    rows = _x(models, db, uid, key, "account.move", "read", [ids],
              {"fields": ["name", "invoice_date", "partner_id", "amount_total",
                          "edi_state", "l10n_ec_authorization_number", "company_id"],
               "context": ctx}) if ids else []
    pids = list({r["partner_id"][0] for r in rows if r.get("partner_id")})
    vat = {}
    if pids:
        for p in _x(models, db, uid, key, "res.partner", "read", [pids], {"fields": ["id", "vat"]}):
            vat[p["id"]] = p.get("vat") or ""
    data = []
    for r in rows:
        pid = r.get("partner_id") or [0, ""]
        data.append({
            "numero": r.get("name"),
            "fecha": r.get("invoice_date"),
            "ruc": vat.get(pid[0], ""),
            "nombre": pid[1],
            "total": r.get("amount_total"),
            "empresa": (r.get("company_id") or [0, ""])[1],
            "edi_state": r.get("edi_state"),
            "autorizada": bool(r.get("l10n_ec_authorization_number")),
            "autorizacion": r.get("l10n_ec_authorization_number") or None,
        })
    return {"data": data}


@router.get("/cobros-pendientes")
async def cobros_pendientes(user_id: str = Depends(get_current_user)):
    """Clientes con facturas de venta pendientes de cobro en Odoo (para el aviso
    al iniciar sesión). Excluye la empresa emisora 'Marco Antonio'. Agrupado por
    cliente con el monto total que falta por pagar."""
    try:
        models, uid, db, key = _connect()
    except Exception:
        return {"data": []}
    dom = [["move_type", "=", "out_invoice"], ["state", "=", "posted"],
           ["payment_state", "in", ["not_paid", "partial"]]]
    ids = _x(models, db, uid, key, "account.move", "search", [dom], {"limit": 500})
    rows = _x(models, db, uid, key, "account.move", "read", [ids],
              {"fields": ["name", "partner_id", "amount_residual", "company_id"]}) if ids else []
    rows = [r for r in rows if EXCLUIR_EMISOR not in ((r.get("company_id") or [0, ""])[1] or "").lower()]
    if not rows:
        return {"data": []}
    # RUC (vat) de cada cliente para poder enlazar al módulo
    pids = list({(r["partner_id"][0]) for r in rows if r.get("partner_id")})
    vat = {}
    if pids:
        for p in _x(models, db, uid, key, "res.partner", "read", [pids], {"fields": ["id", "vat"]}):
            vat[p["id"]] = (p.get("vat") or "")
    por_cliente = {}
    for r in rows:
        pid = r.get("partner_id") or [0, "—"]
        g = por_cliente.setdefault(pid[0], {"cliente": pid[1], "ruc": vat.get(pid[0], ""),
                                            "pendiente": 0.0, "facturas": 0})
        g["pendiente"] += float(r.get("amount_residual") or 0)
        g["facturas"] += 1
    data = sorted(por_cliente.values(), key=lambda x: -x["pendiente"])
    for d in data:
        d["pendiente"] = round(d["pendiente"], 2)
    return {"data": data}


@router.api_route("/recordatorio-cobros", methods=["GET", "POST"])
async def recordatorio_cobros(token: Optional[str] = None):
    """Recordatorio SEMANAL de cobros pendientes a Johanna (lo dispara el cron).
    Incluye las facturas de venta posteadas sin pagar de TODAS las empresas
    emisoras EXCEPTO 'Marco Antonio'. Protegido por token (no requiere sesión)."""
    if not token or token != _CRON_DEFAULT:
        raise HTTPException(status_code=401, detail="Token inválido")
    destino = (ODOO_NOTIFY_EMAIL or "").strip()
    if not destino:
        return {"ok": False, "error": "Sin destinatario configurado"}
    try:
        models, uid, db, key = _connect()
    except HTTPException as e:
        return {"ok": False, "error": e.detail}
    except Exception as e:
        return {"ok": False, "error": f"Odoo: {e}"}

    dom = [["move_type", "=", "out_invoice"], ["state", "=", "posted"],
           ["payment_state", "in", ["not_paid", "partial"]]]
    ids = _x(models, db, uid, key, "account.move", "search", [dom], {"limit": 1000})
    rows = _x(models, db, uid, key, "account.move", "read", [ids],
              {"fields": ["name", "partner_id", "amount_residual", "invoice_date", "company_id"]}) if ids else []
    # Excluir la empresa emisora 'Marco Antonio'
    pend = [r for r in rows if EXCLUIR_EMISOR not in ((r.get("company_id") or [0, ""])[1] or "").lower()]
    if not pend:
        return {"ok": True, "enviado": False, "motivo": "Sin cobros pendientes (o todos de Marco Antonio)"}

    por_emisor, total = {}, 0.0
    for r in pend:
        comp = (r.get("company_id") or [0, "—"])[1]
        partner = (r.get("partner_id") or [0, "—"])[1]
        res = float(r.get("amount_residual") or 0)
        total += res
        por_emisor.setdefault(comp, []).append(
            f"   - {partner}: {r.get('name')} — pendiente ${res:,.2f} (emitida {r.get('invoice_date') or 's/f'})")
    bloques = [f"{comp}:\n" + "\n".join(items) for comp, items in por_emisor.items()]
    cuerpo = ("Johanna, recordatorio semanal de COBROS pendientes (todas las empresas excepto Marco Antonio).\n"
              "Por favor gestiona el cobro de estos valores:\n\n"
              + "\n\n".join(bloques)
              + f"\n\nTOTAL pendiente de cobro: ${total:,.2f}\n\nGracias.")
    if not email_configurado():
        return {"ok": False, "configurado": False, "facturas": len(pend),
                "total": round(total, 2), "error": "SMTP no configurado en el servidor"}
    ok, err = enviar_correo(destino, f"Recordatorio semanal de cobros — {len(pend)} factura(s)", cuerpo)
    return {"ok": ok, "enviado": ok, "facturas": len(pend), "total": round(total, 2), "error": err}


@router.post("/facturar")
async def facturar_en_odoo(body: FacturarBody, user_id: str = Depends(get_current_user)):
    """Crea y confirma (posted) facturas de venta en Odoo. Solo admins.

    Por cada entrada en `facturas`:
      - Busca o crea el res.partner por VAT (RUC).
      - Por cada línea, busca o crea el product.product por nombre (type=service).
      - Crea account.move (out_invoice) y la confirma con action_post.
    """
    if not body.facturas:
        raise HTTPException(status_code=400, detail="No hay facturas para crear")

    # Acceso: admin y socio pueden facturar cualquier empresa; un 'cliente' solo
    # las empresas (contribuyentes) que le fueron autorizadas.
    sb = get_supabase_client()
    idents_ok = None
    if rol_de(user_id) == "cliente":
        idents_ok = _idents_autorizadas(sb, user_id)

    try:
        models, uid, db, key = _connect()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error conectando a Odoo: {e}")

    # Nombre de cada empresa emisora (para saber cuál es "Marco Antonio" y excluirla del aviso a Johanna).
    emp_nombre = {}
    try:
        for c in _x(models, db, uid, key, "res.company", "read",
                    [_x(models, db, uid, key, "res.company", "search", [[]])], {"fields": ["id", "name"]}):
            emp_nombre[c["id"]] = c.get("name") or ""
    except Exception:
        pass

    resultados = []
    for fac in body.facturas:
        try:
            if idents_ok is not None and fac.ruc not in idents_ok:
                resultados.append({"ruc": fac.ruc, "nombre": fac.nombre,
                                   "ok": False, "error": "No autorizado para facturar a esta empresa"})
                continue
            lineas_cobrables = [l for l in fac.lineas if l.valor > 0]
            if not lineas_cobrables:
                resultados.append({"ruc": fac.ruc, "nombre": fac.nombre,
                                   "ok": False, "error": "Sin líneas con valor > 0"})
                continue

            company = fac.company_id or body.company_id

            partner_id = _find_or_create_partner(models, db, uid, key, fac.ruc, fac.nombre)

            # ANTI-DUPLICADO: si este cliente YA tiene una factura de este mes por esta
            # empresa, NO se crea otra; se devuelve la existente para pasar al SRI.
            ini_mes = datetime.now(_EC_TZ_ODOO).strftime("%Y-%m-01")
            dom_dup = [["move_type", "=", "out_invoice"], ["partner_id", "=", partner_id],
                       ["state", "=", "posted"], ["invoice_date", ">=", ini_mes]]
            if company:
                dom_dup.append(["company_id", "=", company])
            ya = _x(models, db, uid, key, "account.move", "search", [dom_dup],
                    {"limit": 1, "order": "id desc", "context": _ctx_emp(company)})
            if ya:
                m = _x(models, db, uid, key, "account.move", "read", [ya],
                       {"fields": ["name", "amount_total", "state", "payment_state", "edi_state",
                                   "l10n_ec_authorization_number"], "context": _ctx_emp(company)})[0]
                resultados.append({
                    "ruc": fac.ruc, "nombre": fac.nombre, "ok": True, "ya_existia": True,
                    "odoo_id": ya[0], "numero": m.get("name"), "total": m.get("amount_total"),
                    "estado": m.get("state"), "payment_state": m.get("payment_state"),
                    "emisor_nombre": emp_nombre.get(company, ""),
                })
                continue  # no se duplica; el siguiente paso (SRI) lo maneja la verificación

            # Impuesto IVA 15% (411, S) de la empresa emisora, para fijarlo en cada línea.
            tax_id = _iva_15_s_id(models, db, uid, key, company)

            invoice_lines = []
            for ln in lineas_cobrables:
                # Producto: 1) el elegido por id; 2) buscar/crear por el nombre tecleado;
                # 3) si no, por el concepto. _find_or_create busca y crea si no existe.
                nombre_prod = (ln.producto_nombre or "").strip() or ln.concepto
                product_id = ln.product_id or _find_or_create_product(models, db, uid, key, nombre_prod)
                line_vals = {
                    "product_id": product_id,
                    "name": ln.concepto,
                    "quantity": 1.0,
                }
                if tax_id:
                    line_vals["tax_ids"] = [(6, 0, [tax_id])]  # IVA 15% (411, S)
                desc = float(ln.descuento or 0)
                if ln.precio_oficial and float(ln.precio_oficial) > 0:
                    # Respetar el PRECIO OFICIAL y mandar el DESCUENTO a Odoo.
                    oficial = round(float(ln.precio_oficial) / (1 + IVA_RATE), 2) if fac.iva_incluido else float(ln.precio_oficial)
                    line_vals["price_unit"] = oficial
                    line_vals["discount"] = round(desc, 2)
                else:
                    # Sin precio oficial: el neto va directo (base imponible si trae IVA).
                    line_vals["price_unit"] = round(ln.valor / (1 + IVA_RATE), 2) if fac.iva_incluido else ln.valor
                invoice_lines.append((0, 0, line_vals))

            # Registro contable: asignar la cuenta por cobrar del cliente (si se eligió)
            # para que la factura vaya a ESA cuenta, no a la genérica. La cuenta es del
            # plan de la empresa emisora, así que se escribe en su contexto.
            if fac.cuenta_cobrar_id:
                try:
                    _x(models, db, uid, key, "res.partner", "write",
                       [[partner_id], {"property_account_receivable_id": fac.cuenta_cobrar_id}],
                       {"context": _ctx_emp(company)})
                except Exception as e:
                    print(f"[odoo] no se pudo asignar cuenta por cobrar {fac.ruc}: {e}")

            move_vals = {
                "move_type": "out_invoice",
                "partner_id": partner_id,
                "invoice_line_ids": invoice_lines,
            }
            if company:
                move_vals["company_id"] = company
            inv_id = _x(models, db, uid, key, "account.move", "create", [move_vals])

            # Confirmar la factura
            _x(models, db, uid, key, "account.move", "action_post", [[inv_id]])

            # Registro directo en banco: registrar el cobro (queda PAGADA).
            cobro_banco = None
            if fac.banco_journal_id:
                try:
                    _registrar_pago(models, db, uid, key, inv_id, fac.banco_journal_id)
                    cobro_banco = "registrado"
                except Exception as e:
                    cobro_banco = f"error: {e}"
                    print(f"[odoo] no se pudo registrar el cobro en banco {fac.ruc}: {e}")

            # Leer número y total resultante
            inv_data = _x(models, db, uid, key, "account.move", "read",
                          [[inv_id]], {"fields": ["name", "amount_total", "state", "payment_state"]})
            inv_info = inv_data[0] if inv_data else {}

            resultados.append({
                "ruc": fac.ruc,
                "nombre": fac.nombre,
                "ok": True,
                "odoo_id": inv_id,
                "numero": inv_info.get("name"),
                "total": inv_info.get("amount_total"),
                "estado": inv_info.get("state"),
                "payment_state": inv_info.get("payment_state"),
                "cobro_banco": cobro_banco,
                "impuesto_ok": bool(tax_id),
                "emisor_id": company,
                "emisor_nombre": emp_nombre.get(company, ""),
            })
        except Exception as e:
            resultados.append({"ruc": fac.ruc, "nombre": fac.nombre,
                               "ok": False, "error": str(e)})

    exitosas = [r for r in resultados if r.get("ok")]
    if exitosas:
        # Cada emisión queda en Movimientos.
        for r in exitosas:
            registrar(actor_user_id=user_id, action="emit", module="facturacion",
                      entity="Factura emitida en Odoo", identificacion=r.get("ruc"),
                      contribuyente=r.get("nombre"),
                      metadata={"numero": r.get("numero"), "total": r.get("total")})
        # Aviso a Johanna de las facturas generadas para que gestione el cobro, SOLO
        # las que le corresponden (se excluye la empresa emisora 'Marco Antonio').
        # No se auto-notifica si quien emite es la propia Johanna.
        notificables = [r for r in exitosas
                        if EXCLUIR_EMISOR not in (r.get("emisor_nombre") or "").lower()]
        if notificables:
            threading.Thread(
                target=_notificar_johanna,
                kwargs={"actor_user_id": user_id, "exitosas": notificables},
                daemon=True,
            ).start()

    return {"resultados": resultados}
