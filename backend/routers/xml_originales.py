# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Los XML originales del SRI: se guardan al subirlos y se pueden volver a ver.

Hasta ahora solo se podían RE-DESCARGAR en un ZIP, y únicamente los del período
que estuviera abierto en pantalla. El respaldo estaba —2.850 comprobantes desde
julio de 2025— pero no había forma de mirarlo: para ver qué se cargó en un mes
anterior había que cambiar el período del contribuyente y bajarse el ZIP entero.

Ahora hay archivo consultable: qué contribuyentes tienen XML, qué meses tiene
cada uno, qué comprobantes hay en cada mes (número, fecha, emisor y total, leídos
del propio XML) y el contenido de cualquiera de ellos.

El contenido se guarda tal cual vino del SRI: ante una discusión, manda el
original, y de él se puede volver a calcular todo."""
import io
import re
import xml.etree.ElementTree as ET
import zipfile
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from auth import get_current_user
from database import get_supabase_client, fetch_in
from services.xml_parser import find_node_ignore_ns, find_text_ignore_ns
from tenancy import assert_client_owner, visible_clients

router = APIRouter(prefix="/api/xml-originales", tags=["xml-originales"])

TIPO_LABEL = {
    "gasto": "Gastos", "ingreso_ice": "IngresosICE",
    "ingreso_iva": "IngresosIVA", "retencion": "Retenciones",
    "retencion_efectuada": "RetencionesEfectuadas",
}


def _slug(s):
    return (re.sub(r"[^A-Za-z0-9]+", "", (s or "").upper())[:20]) or "CLIENTE"


def _raiz(xml_content: str):
    """Nodo del comprobante. Los XML autorizados por el SRI traen el documento
    dentro de <autorizacion><comprobante> con CDATA; ahí está lo que interesa."""
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError:
        return None
    nodo = find_node_ignore_ns(root, "comprobante")
    if nodo is not None and nodo.text:
        interno = nodo.text.strip().replace("<![CDATA[", "").replace("]]>", "").strip()
        try:
            return ET.fromstring(interno)
        except ET.ParseError:
            return root
    return root


# codDoc del SRI → cómo se llama en cristiano
_TIPO_DOC = {
    "01": "Factura", "03": "Liq. de compra", "04": "Nota de crédito",
    "05": "Nota de débito", "06": "Guía de remisión", "07": "Retención",
}


def _ficha(xml_content: str) -> dict:
    """Lo mínimo para reconocer un comprobante en una lista: qué es, de quién,
    de cuándo y por cuánto. Se lee del XML en el momento y no se guarda aparte:
    el original ya está, y duplicar sus datos en columnas es una copia más que
    mantener sincronizada.

    Nunca lanza: un XML ilegible aparece en la lista como tal, que es más útil
    que desaparecer de ella."""
    vacia = {"numero": "", "fecha": "", "emisor": "", "ruc": "", "total": None,
             "tipo": "", "clave": "", "receptor": ""}
    root = _raiz(xml_content or "")
    if root is None:
        return {**vacia, "tipo": "(no se pudo leer)"}
    try:
        trib = find_node_ignore_ns(root, "infoTributaria")
        # Cada documento nombra su bloque de info a su manera.
        info = None
        for tag in ("infoFactura", "infoCompRetencion", "infoNotaCredito",
                    "infoNotaDebito", "infoLiquidacionCompra"):
            info = find_node_ignore_ns(root, tag)
            if info is not None:
                break
        estab = find_text_ignore_ns(trib, "estab")
        pto = find_text_ignore_ns(trib, "ptoEmi")
        sec = find_text_ignore_ns(trib, "secuencial")
        total = find_text_ignore_ns(info, "importeTotal") or find_text_ignore_ns(info, "valorRetenido")
        try:
            total = round(float(total), 2) if total else None
        except ValueError:
            total = None
        return {
            "numero": f"{estab}-{pto}-{sec}" if sec else "",
            "fecha": find_text_ignore_ns(info, "fechaEmision"),
            "emisor": find_text_ignore_ns(trib, "razonSocial"),
            "ruc": find_text_ignore_ns(trib, "ruc"),
            "receptor": (find_text_ignore_ns(info, "razonSocialComprador")
                         or find_text_ignore_ns(info, "razonSocialSujetoRetenido")),
            "total": total,
            "tipo": _TIPO_DOC.get(find_text_ignore_ns(trib, "codDoc"), ""),
            "clave": find_text_ignore_ns(trib, "claveAcceso"),
        }
    except Exception as e:
        print(f"[xml-originales] no se pudo leer la ficha de un XML: {e}")
        return {**vacia, "tipo": "(no se pudo leer)"}


def _client_ids_visibles(user_id: str, identificacion: Optional[str] = None) -> dict:
    """Períodos (filas de `clients`) que este usuario puede ver, por id. Es el
    filtro de seguridad de todo el archivo: solo se consultan XML de estos."""
    filas = visible_clients(user_id, "id,identificacion,nombre,periodo_mes,periodo_anio")
    if identificacion:
        filas = [c for c in filas if c.get("identificacion") == identificacion]
    return {c["id"]: c for c in filas}


@router.get("/contribuyentes")
async def contribuyentes_con_xml(user_id: str = Depends(get_current_user)):
    """Contribuyentes con XML guardados, con cuántos tiene cada uno. Alimenta el
    selector del archivo: se listan solo los que tienen algo que mirar."""
    periodos = _client_ids_visibles(user_id)
    if not periodos:
        return {"data": []}
    sb = get_supabase_client()
    filas = fetch_in(lambda: sb.table("xml_originales").select("client_id,modulo"),
                     list(periodos.keys()))
    por_ruc: dict = {}
    for f in filas:
        c = periodos.get(f["client_id"])
        if not c:
            continue
        ident = c.get("identificacion") or ""
        d = por_ruc.setdefault(ident, {
            "identificacion": ident, "nombre": c.get("nombre") or ident,
            "total": 0, "modulos": {}, "periodos": set(),
        })
        d["total"] += 1
        d["modulos"][f["modulo"]] = d["modulos"].get(f["modulo"], 0) + 1
        d["periodos"].add(f["client_id"])
    out = []
    for d in por_ruc.values():
        d["periodos"] = len(d["periodos"])
        out.append(d)
    out.sort(key=lambda x: (x["nombre"] or "").upper())
    return {"data": out}


@router.get("/periodos")
async def periodos_con_xml(identificacion: str = Query(...),
                           user_id: str = Depends(get_current_user)):
    """Meses de ese contribuyente que tienen XML, del más reciente al más
    antiguo, con el desglose por módulo."""
    periodos = _client_ids_visibles(user_id, identificacion)
    if not periodos:
        raise HTTPException(status_code=404, detail="Contribuyente no encontrado o sin acceso")
    sb = get_supabase_client()
    filas = fetch_in(lambda: sb.table("xml_originales").select("client_id,modulo"),
                     list(periodos.keys()))
    por_periodo: dict = {}
    for f in filas:
        c = periodos[f["client_id"]]
        d = por_periodo.setdefault(f["client_id"], {
            "client_id": f["client_id"],
            "anio": c.get("periodo_anio"), "mes": c.get("periodo_mes"),
            "total": 0, "modulos": {},
        })
        d["total"] += 1
        d["modulos"][f["modulo"]] = d["modulos"].get(f["modulo"], 0) + 1
    out = sorted(por_periodo.values(),
                 key=lambda p: (p["anio"] or 0, p["mes"] or 0), reverse=True)
    return {"data": out, "labels": TIPO_LABEL}


@router.get("/listar")
async def listar(client_id: str = Query(...), modulo: Optional[str] = Query(None),
                 user_id: str = Depends(get_current_user)):
    """Comprobantes guardados de un período: número, fecha, emisor y total,
    leídos del propio XML."""
    assert_client_owner(client_id, user_id)
    sb = get_supabase_client()
    q = sb.table("xml_originales").select("id,modulo,unique_id,xml_content,created_at")\
        .eq("client_id", client_id)
    if modulo:
        q = q.eq("modulo", modulo)
    filas = q.order("created_at").execute().data or []
    out = []
    for f in filas:
        out.append({
            "id": f["id"], "modulo": f["modulo"],
            "guardado": f.get("created_at"),
            "tamano": len(f.get("xml_content") or ""),
            **_ficha(f.get("xml_content")),
        })
    # Por fecha de emisión, que es el orden en el que la gente los busca.
    out.sort(key=lambda x: (x.get("fecha") or "", x.get("numero") or ""))
    return {"data": out}


@router.get("/ver")
async def ver(id: str = Query(...), user_id: str = Depends(get_current_user)):
    """El XML completo, tal como vino del SRI, para leerlo o copiarlo."""
    sb = get_supabase_client()
    filas = sb.table("xml_originales").select("client_id,modulo,xml_content")\
        .eq("id", id).limit(1).execute().data
    if not filas:
        raise HTTPException(status_code=404, detail="XML no encontrado")
    fila = filas[0]
    # El acceso se comprueba contra el contribuyente dueño, no contra el id del
    # XML: adivinar un uuid no puede abrir el comprobante de otro.
    assert_client_owner(fila["client_id"], user_id)
    return {"modulo": fila["modulo"], "xml": fila.get("xml_content") or "",
            **_ficha(fila.get("xml_content"))}


@router.get("/contar")
async def contar(client_id: str = Query(...), modulo: str = Query(...), user_id: str = Depends(get_current_user)):
    assert_client_owner(client_id, user_id)
    sb = get_supabase_client()
    r = sb.table("xml_originales").select("id", count="exact").eq(
        "client_id", client_id).eq("modulo", modulo).execute()
    return {"count": r.count or 0}


@router.get("/descargar")
async def descargar(client_id: str = Query(...), modulo: str = Query(...), user_id: str = Depends(get_current_user)):
    assert_client_owner(client_id, user_id)
    sb = get_supabase_client()
    rows = sb.table("xml_originales").select("unique_id,xml_content").eq(
        "client_id", client_id).eq("modulo", modulo).execute().data or []
    if not rows:
        raise HTTPException(status_code=404, detail="No hay XML originales guardados para este módulo y período. Se guardan automáticamente desde ahora, al subir nuevos XML.")
    cl = sb.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute().data
    c = cl[0] if cl else {}
    ruc = c.get("identificacion", "") or ""
    nombre = _slug(c.get("nombre", ""))
    mes = str(c.get("periodo_mes") or "").zfill(2)
    anio = str(c.get("periodo_anio") or "")
    base = f"{TIPO_LABEL.get(modulo, modulo)}_{ruc}_{nombre}_{mes}_{anio}"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i, row in enumerate(rows, 1):
            z.writestr(f"{base}_{i:03d}.xml", row.get("xml_content") or "")
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={base}.zip"})
