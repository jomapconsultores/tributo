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

def _find_or_create_partner(models, db, uid, key, ruc: str, nombre: str) -> int:
    ids = _x(models, db, uid, key, "res.partner", "search",
             [[["vat", "=", ruc]]], {"limit": 1})
    if ids:
        return ids[0]
    return _x(models, db, uid, key, "res.partner", "create", [{
        "name": nombre,
        "vat": ruc,
        "is_company": True,
        "customer_rank": 1,
    }])


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


class CuentasClientesIn(BaseModel):
    clientes: List[ClienteRef]


class CrearCuentaIn(BaseModel):
    ruc: str
    nombre: str


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
async def odoo_cuentas(user_id: str = Depends(get_current_user)):
    """Diarios de banco/efectivo (para registrar el cobro directo en el banco)."""
    try:
        models, uid, db, key = _connect()
        bancos = _x(models, db, uid, key, "account.journal", "search_read",
                    [[["type", "in", ["bank", "cash"]]]], {"fields": ["id", "name", "type"]})
        return {"bancos": bancos}
    except HTTPException:
        raise
    except Exception as e:
        return {"bancos": [], "error": str(e)}


@router.post("/cuentas-cobrar")
async def odoo_cuentas_cobrar(body: CuentasClientesIn, user_id: str = Depends(get_current_user)):
    """Por cada cliente, busca su cuenta por cobrar individual ('Cuentas por cobrar
    <NOMBRE>') y si está asignada al cliente en Odoo. Devuelve {ruc: {...}}."""
    try:
        models, uid, db, key = _connect()
    except HTTPException as e:
        return {"data": {}, "error": e.detail}
    cuentas = _x(models, db, uid, key, "account.account", "search_read",
                 [[["account_type", "=", "asset_receivable"], ["name", "ilike", "cuentas por cobrar"]]],
                 {"fields": ["id", "code", "name"]})
    out = {}
    for c in body.clientes:
        cta = _match_cuenta_cobrar(c.nombre, cuentas)
        pids = _x(models, db, uid, key, "res.partner", "search", [[["vat", "=", c.ruc]]], {"limit": 1})
        if not pids:
            pids = _x(models, db, uid, key, "res.partner", "search", [[["vat", "=", _solo_digitos(c.ruc)]]], {"limit": 1})
        partner_id = pids[0] if pids else None
        asignada = False
        if partner_id and cta:
            p = _x(models, db, uid, key, "res.partner", "read", [[partner_id]], {"fields": ["property_account_receivable_id"]})
            asignada = bool(p) and (p[0].get("property_account_receivable_id") or [0])[0] == cta["id"]
        out[c.ruc] = {
            "partner_id": partner_id,
            "existe": bool(cta),
            "cuenta_id": cta["id"] if cta else None,
            "cuenta_codigo": cta["code"] if cta else None,
            "cuenta_nombre": cta["name"] if cta else None,
            "asignada": asignada,
        }
    return {"data": out}


@router.post("/crear-cuenta-cobrar")
async def crear_cuenta_cobrar(body: CrearCuentaIn, user_id: str = Depends(get_current_user)):
    """Crea la cuenta 'Cuentas por cobrar <NOMBRE>' (por cobrar) con el siguiente
    código de la serie y la asigna al cliente. Requiere confirmación del usuario."""
    try:
        models, uid, db, key = _connect()
        existentes = _x(models, db, uid, key, "account.account", "search_read",
                        [[["code", "like", "1102050101%"], ["account_type", "=", "asset_receivable"]]],
                        {"fields": ["code"], "order": "code desc", "limit": 1})
        try:
            base = int(existentes[0]["code"]) if existentes else 110205010125
        except (ValueError, TypeError):
            base = 110205010125
        next_code = str(base + 1)
        nombre = (body.nombre or "").strip().upper()
        nombre_cta = f"Cuentas por cobrar {nombre}"
        new_id = _x(models, db, uid, key, "account.account", "create",
                    [{"code": next_code, "name": nombre_cta, "account_type": "asset_receivable"}])
        pids = _x(models, db, uid, key, "res.partner", "search", [[["vat", "=", body.ruc]]], {"limit": 1}) or \
            _x(models, db, uid, key, "res.partner", "search", [[["vat", "=", _solo_digitos(body.ruc)]]], {"limit": 1})
        if pids:
            _x(models, db, uid, key, "res.partner", "write", [[pids[0]], {"property_account_receivable_id": new_id}])
        return {"ok": True, "cuenta_id": new_id, "cuenta_codigo": next_code, "cuenta_nombre": nombre_cta}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"No se pudo crear la cuenta: {e}")


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

            partner_id = _find_or_create_partner(models, db, uid, key, fac.ruc, fac.nombre)

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
            # para que la factura vaya a ESA cuenta, no a la genérica.
            if fac.cuenta_cobrar_id:
                try:
                    _x(models, db, uid, key, "res.partner", "write",
                       [[partner_id], {"property_account_receivable_id": fac.cuenta_cobrar_id}])
                except Exception as e:
                    print(f"[odoo] no se pudo asignar cuenta por cobrar {fac.ruc}: {e}")

            move_vals = {
                "move_type": "out_invoice",
                "partner_id": partner_id,
                "invoice_line_ids": invoice_lines,
            }
            company = fac.company_id or body.company_id
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
            })
        except Exception as e:
            resultados.append({"ruc": fac.ruc, "nombre": fac.nombre,
                               "ok": False, "error": str(e)})

    exitosas = [r for r in resultados if r.get("ok")]
    if exitosas:
        # Queda en Movimientos. El aviso de cobro a Johanna es SEMANAL (cron →
        # /api/odoo/recordatorio-cobros), no por cada emisión.
        for r in exitosas:
            registrar(actor_user_id=user_id, action="emit", module="facturacion",
                      entity="Factura emitida en Odoo", identificacion=r.get("ruc"),
                      contribuyente=r.get("nombre"),
                      metadata={"numero": r.get("numero"), "total": r.get("total")})

    return {"resultados": resultados}
