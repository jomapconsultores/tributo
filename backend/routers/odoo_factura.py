"""Integración con Odoo 19: crea y confirma facturas de venta desde honorarios.

Credenciales Odoo desde variables de entorno (nunca hardcodeadas):
  ODOO_URL        https://cmaj-asociados-sas.odoo.com
  ODOO_DB         cmaj-asociados-sas
  ODOO_USERNAME   jomapconsultores@outlook.com
  ODOO_API_KEY    (api key de Odoo)
"""
import os
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
# Modelos Pydantic
# ---------------------------------------------------------------------------

class LineaIn(BaseModel):
    concepto: str
    valor: float
    product_id: Optional[int] = None      # producto Odoo a usar (si se eligió uno)
    producto_nombre: Optional[str] = None  # nombre del producto a buscar/crear (lo tecleado)


class FacturaIn(BaseModel):
    ruc: str
    nombre: str
    lineas: List[LineaIn]
    iva_incluido: bool = False
    company_id: Optional[int] = None   # empresa EMISORA de ESTA factura (override del global)


class FacturarBody(BaseModel):
    facturas: List[FacturaIn]
    company_id: Optional[int] = None   # empresa EMISORA por defecto (si la factura no trae una)


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
                # Si el valor YA incluye IVA, extraemos la base imponible
                base = round(ln.valor / (1 + IVA_RATE), 2) if fac.iva_incluido else ln.valor
                # Producto: 1) el elegido por id; 2) buscar/crear por el nombre tecleado;
                # 3) si no, por el concepto. _find_or_create busca y crea si no existe.
                nombre_prod = (ln.producto_nombre or "").strip() or ln.concepto
                product_id = ln.product_id or _find_or_create_product(models, db, uid, key, nombre_prod)
                invoice_lines.append((0, 0, {
                    "product_id": product_id,
                    "name": ln.concepto,
                    "quantity": 1.0,
                    "price_unit": base,
                }))

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

            # Leer número y total resultante
            inv_data = _x(models, db, uid, key, "account.move", "read",
                          [[inv_id]], {"fields": ["name", "amount_total", "state"]})
            inv_info = inv_data[0] if inv_data else {}

            resultados.append({
                "ruc": fac.ruc,
                "nombre": fac.nombre,
                "ok": True,
                "odoo_id": inv_id,
                "numero": inv_info.get("name"),
                "total": inv_info.get("amount_total"),
                "estado": inv_info.get("state"),
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
