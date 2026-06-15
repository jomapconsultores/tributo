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
from typing import List
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
    """Avisa por correo a la responsable de facturación. Corre en hilo aparte.
    No se llama cuando emite el administrador (Marco Antonio)."""
    destino = (ODOO_NOTIFY_EMAIL or "").strip()
    if not destino or not email_configurado():
        return
    actor = _email_de(actor_user_id) or "Un usuario"
    lineas, total = [], 0.0
    for r in exitosas:
        t = float(r.get("total") or 0)
        total += t
        lineas.append(f"  - {r.get('nombre')} ({r.get('ruc')}): {r.get('numero') or 's/n'}  ${t:,.2f}")
    cuerpo = (
        f"{actor} emitió {len(exitosas)} factura(s) en Odoo:\n\n"
        + "\n".join(lineas)
        + f"\n\nTotal: ${total:,.2f}\n\nEmitidas según los permisos y empresas autorizadas."
    )
    try:
        enviar_correo(destino, f"Factura(s) emitida(s) en Odoo — {len(exitosas)}", cuerpo)
    except Exception as e:
        print(f"[odoo] fallo aviso a {destino}: {e}")


# ---------------------------------------------------------------------------
# Helpers de conexión
# ---------------------------------------------------------------------------

def _cfg():
    url = os.getenv("ODOO_URL", "").rstrip("/")
    db = os.getenv("ODOO_DB", "")
    user = os.getenv("ODOO_USERNAME", "")
    key = os.getenv("ODOO_API_KEY", "")
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


class FacturaIn(BaseModel):
    ruc: str
    nombre: str
    lineas: List[LineaIn]
    iva_incluido: bool = False


class FacturarBody(BaseModel):
    facturas: List[FacturaIn]


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
                product_id = _find_or_create_product(models, db, uid, key, ln.concepto)
                invoice_lines.append((0, 0, {
                    "product_id": product_id,
                    "name": ln.concepto,
                    "quantity": 1.0,
                    "price_unit": base,
                }))

            inv_id = _x(models, db, uid, key, "account.move", "create", [{
                "move_type": "out_invoice",
                "partner_id": partner_id,
                "invoice_line_ids": invoice_lines,
            }])

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
        # Queda en Movimientos (sin correo de actividad; el aviso es el de Johanna)
        for r in exitosas:
            registrar(actor_user_id=user_id, action="emit", module="facturacion",
                      entity="Factura emitida en Odoo", identificacion=r.get("ruc"),
                      contribuyente=r.get("nombre"),
                      metadata={"numero": r.get("numero"), "total": r.get("total")},
                      notificar=False)
        # Aviso por correo a Johanna SALVO si emite el administrador (Marco Antonio)
        if not es_super_admin(user_id):
            threading.Thread(target=_notificar_johanna,
                             kwargs=dict(actor_user_id=user_id, exitosas=exitosas),
                             daemon=True).start()

    return {"resultados": resultados}
