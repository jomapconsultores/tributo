"""Router para INGRESOS IVA (facturas de venta SIN ICE).

Para contribuyentes que solo declaran IVA (no ICE). Las facturas con ICE deben
ir al router /api/ice. Si una factura subida acá contiene ICE, se rechaza con
estado='CON_ICE' y se reporta en el resumen para que el usuario sepa.
"""
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.xml_parser_ventas import parse_venta_xml
from services.pdf_parser_ventas import parse_venta_pdf
from services.xml_store import guardar_xml_original
from services.periodo import periodo_cliente, es_de_otro_periodo, etiqueta_periodo
from services.sri_service import extract_claves_from_txt, descargar_multiples_xmls
from services.activity import registrar
from database import fetch_all
from tenancy import assert_client_owner, shared_client_ids

router = APIRouter(prefix="/api/sales-iva", tags=["sales_iva"])

COLUMNS = (
    "id,client_id,unique_id,estado,fecha,tipo_id_cliente,id_cliente,razon_social_cliente,"
    "factura_numero,no_objeto_iva,exento_iva,base_0,base_15,iva_15,base_5,iva_5,"
    "importe_total,notas,created_at"
)


class BulkMove(BaseModel):
    ids: List[str]
    client_id: str


class BulkIds(BaseModel):
    ids: List[str]


class SaleUpdate(BaseModel):
    """Edición manual de una factura de venta. Todos los campos son opcionales;
    solo se actualizan los enviados."""
    fecha: Optional[str] = None
    tipo_id_cliente: Optional[str] = None
    id_cliente: Optional[str] = None
    razon_social_cliente: Optional[str] = None
    factura_numero: Optional[str] = None
    no_objeto_iva: Optional[float] = None
    exento_iva: Optional[float] = None
    base_0: Optional[float] = None
    base_15: Optional[float] = None
    iva_15: Optional[float] = None
    base_5: Optional[float] = None
    iva_5: Optional[float] = None
    importe_total: Optional[float] = None
    notas: Optional[str] = None


@router.get("/")
async def list_sales(user_id: str = Depends(get_current_user), client_id: Optional[str] = Query(None)):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            data = fetch_all(lambda: supabase.table("sales_iva").select(COLUMNS).eq("client_id", client_id).order("fecha", desc=True))
        else:
            own = fetch_all(lambda: supabase.table("sales_iva").select(COLUMNS).eq("user_id", user_id).order("fecha", desc=True))
            sids = shared_client_ids(user_id)
            if sids:
                sh = fetch_all(lambda: supabase.table("sales_iva").select(COLUMNS).in_("client_id", sids).order("fecha", desc=True))
                seen, data = set(), []
                for r in own + sh:
                    if r["id"] not in seen:
                        seen.add(r["id"])
                        data.append(r)
            else:
                data = own
        return {"data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process-xml")
async def process_xml(
    files: List[UploadFile] = File(...),
    client_id: str = Form(...),
    user_id: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        pmes, panio = periodo_cliente(supabase, client_id)
        new_count = dup_count = err_count = rej_count = fp_count = 0
        rechazadas = []  # facturas con ICE
        fuera_periodo = []  # facturas con fecha de otro mes
        for file in files:
            raw = await file.read()
            es_pdf = (file.filename or "").lower().endswith(".pdf") or raw[:5] == b"%PDF-"
            if es_pdf:
                # RIDE del SRI (cuando el XML no está disponible). No hay XML que
                # archivar; los valores se pueden editar luego desde el módulo.
                parsed = parse_venta_pdf(raw)
                xml_content = None
            else:
                xml_content = raw.decode("utf-8", errors="ignore")
                parsed = parse_venta_xml(xml_content)
            if parsed is None:
                err_count += 1
                continue
            if parsed.get("error") == "CON_ICE":
                rej_count += 1
                rechazadas.append({
                    "archivo": file.filename,
                    "factura": parsed.get("factura_numero"),
                    "motivo": parsed.get("message"),
                })
                continue
            if es_de_otro_periodo(parsed.get("fecha"), pmes, panio):
                fp_count += 1
                fuera_periodo.append({
                    "archivo": file.filename,
                    "factura": parsed.get("factura_numero"),
                    "fecha": parsed.get("fecha"),
                })
                continue
            if xml_content:
                guardar_xml_original(supabase, user_id, client_id, "ingreso_iva", xml_content)
            try:
                supabase.table("sales_iva").insert({
                    "client_id": client_id, "user_id": user_id, **parsed
                }).execute()
                new_count += 1
            except Exception as e:
                msg = str(e).lower()
                if "duplicate" in msg or "unique" in msg:
                    dup_count += 1
                else:
                    print(f"Error insertando sales_iva {parsed.get('unique_id')}: {e}")
                    err_count += 1
        if new_count:
            registrar(actor_user_id=user_id, action="upload", module="ingresos_iva",
                      entity="Ingresos IVA (ventas)", client_id=client_id, cantidad=new_count)
        return {
            "ok": True,
            "nuevas": new_count,
            "duplicadas": dup_count,
            "errores": err_count,
            "rechazadas_por_ice": rej_count,
            "rechazadas": rechazadas,
            "fuera_de_periodo": fp_count,
            "fuera_periodo": fuera_periodo,
            "periodo": etiqueta_periodo(pmes, panio),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _guardar_venta(supabase, client_id, user_id, xml_content, pmes=None, panio=None):
    """Parsea un XML de venta y lo guarda en sales_iva. Devuelve uno de:
    'new' | 'dup' | 'err' | 'con_ice' | 'fuera'. (Reutilizado por process-xml y process-txt)."""
    parsed = parse_venta_xml(xml_content)
    if parsed is None:
        return "err", None
    if parsed.get("error") == "CON_ICE":
        return "con_ice", parsed.get("factura_numero")
    if es_de_otro_periodo(parsed.get("fecha"), pmes, panio):
        return "fuera", {"factura": parsed.get("factura_numero"), "fecha": parsed.get("fecha")}
    guardar_xml_original(supabase, user_id, client_id, "ingreso_iva", xml_content)
    try:
        supabase.table("sales_iva").insert({"client_id": client_id, "user_id": user_id, **parsed}).execute()
        return "new", None
    except Exception as e:
        msg = str(e).lower()
        if "duplicate" in msg or "unique" in msg:
            return "dup", None
        print(f"Error insertando sales_iva {parsed.get('unique_id')}: {e}")
        return "err", None


@router.post("/process-txt")
async def process_txt(
    file: UploadFile = File(...),
    client_id: str = Form(...),
    user_id: str = Depends(get_current_user),
):
    """Sube el reporte/lista de claves de acceso (TXT del SRI: 'Descargar reporte'
    de Comprobantes Emitidos). Extrae las claves de 49 dígitos, baja los XML por
    el servicio del SRI (con reintentos) y los guarda como ingresos (ventas)."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        content = (await file.read()).decode("utf-8", errors="ignore")
        claves = extract_claves_from_txt(content)
        if not claves:
            raise HTTPException(status_code=400, detail="No se encontraron claves de acceso (49 dígitos) en el archivo.")
        xmls, no_descargadas = descargar_multiples_xmls(list(claves), max_workers=8, max_rondas=3)

        pmes, panio = periodo_cliente(supabase, client_id)
        new_count = dup_count = err_count = rej_count = fp_count = 0
        rechazadas = []
        fuera_periodo = []
        for xml_content in xmls:
            estado, info = _guardar_venta(supabase, client_id, user_id, xml_content, pmes, panio)
            if estado == "new":
                new_count += 1
            elif estado == "dup":
                dup_count += 1
            elif estado == "con_ice":
                rej_count += 1
                rechazadas.append({"archivo": "(XML del SRI)", "factura": info, "motivo": "Contiene ICE — subir en módulo ICE-XML"})
            elif estado == "fuera":
                fp_count += 1
                fuera_periodo.append({"archivo": "(XML del SRI)", "factura": info.get("factura"), "fecha": info.get("fecha")})
            else:
                err_count += 1
        if new_count:
            registrar(actor_user_id=user_id, action="upload", module="ingresos_iva",
                      entity="Ingresos IVA (ventas)", client_id=client_id, cantidad=new_count)
        return {
            "ok": True,
            "total_claves": len(claves),
            "descargadas": len(xmls),
            "no_descargadas": no_descargadas,
            "nuevas": new_count,
            "duplicadas": dup_count,
            "errores": err_count,
            "rechazadas_por_ice": rej_count,
            "rechazadas": rechazadas,
            "fuera_de_periodo": fp_count,
            "fuera_periodo": fuera_periodo,
            "periodo": etiqueta_periodo(pmes, panio),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/clear")
async def clear(client_id: str = Query(...), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        supabase.table("sales_iva").delete().eq("client_id", client_id).execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{sale_id}")
async def delete_one(sale_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("sales_iva").delete().eq("id", sale_id).eq("user_id", user_id).execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{sale_id}")
async def update_sale(sale_id: str, body: SaleUpdate, user_id: str = Depends(get_current_user)):
    """Edita los datos de una factura de venta ya ingresada (corrección manual,
    típico tras leer un PDF). Si se tocan bases/IVA y no se envía importe_total,
    se recalcula como suma de bases + IVA."""
    try:
        supabase = get_supabase_client()
        cambios = body.dict(exclude_unset=True)
        if not cambios:
            raise HTTPException(status_code=400, detail="Sin cambios")
        # Verificar propiedad y obtener fila actual
        cur = supabase.table("sales_iva").select(COLUMNS).eq("id", sale_id).eq("user_id", user_id).limit(1).execute()
        if not cur.data:
            raise HTTPException(status_code=404, detail="Factura no encontrada")
        row = {**cur.data[0], **cambios}
        # Recalcular total si no se envió explícitamente
        if "importe_total" not in cambios:
            cambios["importe_total"] = round(
                float(row.get("base_0") or 0) + float(row.get("base_15") or 0)
                + float(row.get("iva_15") or 0) + float(row.get("base_5") or 0)
                + float(row.get("iva_5") or 0) + float(row.get("no_objeto_iva") or 0)
                + float(row.get("exento_iva") or 0), 2)
        supabase.table("sales_iva").update(cambios).eq("id", sale_id).eq("user_id", user_id).execute()
        registrar(actor_user_id=user_id, action="update", module="ingresos_iva",
                  entity=f"Factura {row.get('factura_numero') or sale_id}",
                  client_id=row.get("client_id"))
        out = supabase.table("sales_iva").select(COLUMNS).eq("id", sale_id).limit(1).execute()
        return {"ok": True, "data": out.data[0] if out.data else None}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-move")
async def bulk_move(body: BulkMove, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(body.client_id, user_id)
        moved = skipped = 0
        for sale_id in body.ids:
            try:
                supabase.table("sales_iva").update({"client_id": body.client_id}).eq("id", sale_id).eq("user_id", user_id).execute()
                moved += 1
            except Exception:
                skipped += 1
        return {"ok": True, "moved": moved, "skipped": skipped}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-delete")
async def bulk_delete(body: BulkIds, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        for sale_id in body.ids:
            supabase.table("sales_iva").delete().eq("id", sale_id).eq("user_id", user_id).execute()
        return {"ok": True, "deleted": len(body.ids)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
