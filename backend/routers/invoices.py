from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, es_error_duplicado
from services.sri_service import extract_claves_from_txt, descargar_multiples_xmls
from services.xml_parser import parse_xml_invoice
from services.export_service import generate_excel, generate_pdf
from services.xml_store import guardar_xml_original
from services.periodo import (periodo_cliente_ext, es_de_otro_periodo, etiqueta_periodo,
                              identificacion_cliente, identificacion_no_coincide)
from database import fetch_all
from tenancy import assert_client_owner, visible_client_ids, filter_ids_by_tenancy
from services.activity import registrar

router = APIRouter(prefix="/api/invoices", tags=["invoices"])

# Columnas que se devuelven al frontend (vista completa estilo escritorio)
INVOICE_COLUMNS = (
    "id,client_id,unique_id,estado,fecha,ruc_proveedor,factura_numero,nombre_proveedor,"
    "clasificacion,concepto,forma_pago,tarjeta_credito,no_objeto_iva,exento_iva,"
    "base_0,base_15,iva_15,base_8,iva_8,base_5,iva_5,desc_info,desc_manual,total,"
    "base_15_original,total_original,es_yanbal,destinatario,ruc_comprador"
)


class InvoiceUpdate(BaseModel):
    clasificacion: Optional[str] = None
    desc_manual: Optional[float] = None
    tarjeta_credito: Optional[str] = None
    forma_pago: Optional[str] = None
    concepto: Optional[str] = None
    ruc_proveedor: Optional[str] = None
    nombre_proveedor: Optional[str] = None
    fecha: Optional[str] = None


class BulkMove(BaseModel):
    ids: List[str]
    client_id: str


class BulkIds(BaseModel):
    ids: List[str]


def _load_maps(supabase, user_id: str = None):
    """Mapas de clasificación/tarjeta usados para auto-completar una factura al
    subirla. La clasificación usa el catálogo de EQUIPO (catálogo general de los
    admin + overrides del propio usuario), no solo las filas del usuario, para que
    un no-admin también aplique las reglas del equipo y las cargas nuevas no entren
    SIN CLASIFICAR. La memoria de tarjeta sí es personal (por user_id)."""
    from routers.classification import resolve_team_classification
    classification_map = resolve_team_classification(supabase, user_id) if user_id else {}
    mem_q = supabase.table("card_memory").select("mem_key, tarjeta_credito")
    if user_id:
        mem_q = mem_q.eq("user_id", user_id)
    card_memory = {row['mem_key']: row['tarjeta_credito'] for row in (mem_q.execute().data or [])}
    return classification_map, card_memory


def _store_invoice(supabase, client_id: str, user_id: str, invoice: dict) -> str:
    """Inserta una factura para un cliente. Devuelve 'new' | 'duplicate' | 'error'."""
    unique_id = invoice.pop('unique_id')
    try:
        supabase.table("invoices").insert({
            "client_id": client_id,
            "user_id": user_id,
            "unique_id": unique_id,
            **invoice
        }).execute()
        return "new"
    except Exception as e:
        if es_error_duplicado(e):
            return "duplicate"
        print(f"Error insertando factura {unique_id}: {e}")
        return "error"


@router.get("/")
async def list_invoices(
    user_id: str = Depends(get_current_user),
    client_id: Optional[str] = Query(None),
    skip: int = 0,
    limit: int = 500
):
    from routers.access import es_data_admin
    try:
        supabase = get_supabase_client()
        data_admin = es_data_admin(user_id)

        count_q = supabase.table("invoices").select("id", count="exact")
        data_q = supabase.table("invoices").select(INVOICE_COLUMNS)

        if client_id:
            if not data_admin:
                assert_client_owner(client_id, user_id)
            count_q = count_q.eq("client_id", client_id)
            data_q = data_q.eq("client_id", client_id)
        elif not data_admin:
            # Sin client_id: limitar a lo VISIBLE según el rol (no toda la DB).
            # admin entra por data_admin (sin filtro); aquí van socio y cliente.
            ids = list(visible_client_ids(user_id) or [])
            if ids:
                filt = f"user_id.eq.{user_id},client_id.in.({','.join(ids)})"
                count_q = count_q.or_(filt)
                data_q = data_q.or_(filt)
            else:
                count_q = count_q.eq("user_id", user_id)
                data_q = data_q.eq("user_id", user_id)

        total = count_q.execute().count or 0
        response = data_q.order("fecha", desc=True).range(skip, skip + limit - 1).execute()

        return {
            "data": response.data or [],
            "total": total,
            "page": skip // limit + 1,
            "limit": limit
        }
    except Exception as e:
        print(f"Error in list_invoices: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process-txt")
async def process_txt(
    file: UploadFile = File(...),
    client_id: str = Form(...),
    user_id: str = Depends(get_current_user)
):
    try:
        content = await file.read()
        txt_content = content.decode('utf-8', errors='ignore')

        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)

        claves = extract_claves_from_txt(txt_content)
        if not claves:
            raise HTTPException(status_code=400, detail="No se encontraron claves válidas en el archivo")

        claves_list = list(claves)
        # Reintenta en varias rondas las claves que el SRI falle, para bajar
        # TODAS las facturas y no solo una parte.
        xmls, no_descargadas = descargar_multiples_xmls(claves_list, max_workers=8, max_rondas=3)
        errores = no_descargadas

        classification_map, card_memory = _load_maps(supabase, user_id)
        pmes, panio, pfreq, psem = periodo_cliente_ext(supabase, client_id)
        cli_ident = identificacion_cliente(supabase, client_id)

        new_count = dup_count = err_count = fp_count = 0
        fuera_periodo = []
        comprador_ajeno = []  # compras cuyo COMPRADOR no es el contribuyente
        for xml_content in xmls:
            invoice = parse_xml_invoice(xml_content, classification_map, card_memory)
            if not invoice:
                err_count += 1
                continue
            if es_de_otro_periodo(invoice.get("fecha"), pmes, panio, pfreq, psem):
                fp_count += 1
                fuera_periodo.append({"archivo": "(XML del SRI)", "factura": invoice.get("factura_numero"), "fecha": invoice.get("fecha")})
                continue
            if identificacion_no_coincide(invoice.get("ruc_comprador"), cli_ident):
                comprador_ajeno.append({"archivo": "(XML del SRI)", "factura": invoice.get("factura_numero"),
                                        "ruc_comprador": invoice.get("ruc_comprador")})
            guardar_xml_original(supabase, user_id, client_id, "gasto", xml_content)
            result = _store_invoice(supabase, client_id, user_id, invoice)
            if result == "new":
                new_count += 1
            elif result == "duplicate":
                dup_count += 1
            else:
                err_count += 1

        if new_count:
            registrar(actor_user_id=user_id, action="upload", module="gastos",
                      entity="Facturas de gastos", client_id=client_id, cantidad=new_count)
        return {
            "processed": len(xmls),
            "new": new_count,
            "duplicates": dup_count,
            "errors": errores + err_count,
            "total_claves": len(claves),
            "descargadas": len(xmls),
            "no_descargadas": no_descargadas,
            "fuera_de_periodo": fp_count,
            "fuera_periodo": fuera_periodo,
            "comprador_ajeno": comprador_ajeno,
            "periodo": etiqueta_periodo(pmes, panio, pfreq, psem),
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in process_txt: {e}")
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/process-xml")
async def process_xml(
    files: List[UploadFile] = File(...),
    client_id: str = Form(...),
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        classification_map, card_memory = _load_maps(supabase, user_id)
        pmes, panio, pfreq, psem = periodo_cliente_ext(supabase, client_id)
        cli_ident = identificacion_cliente(supabase, client_id)

        new_count = dup_count = err_count = fp_count = 0
        fuera_periodo = []
        comprador_ajeno = []
        for file in files:
            xml_content = (await file.read()).decode('utf-8', errors='ignore')
            invoice = parse_xml_invoice(xml_content, classification_map, card_memory)
            if not invoice:
                err_count += 1
                continue
            if es_de_otro_periodo(invoice.get("fecha"), pmes, panio, pfreq, psem):
                fp_count += 1
                fuera_periodo.append({"archivo": file.filename, "factura": invoice.get("factura_numero"), "fecha": invoice.get("fecha")})
                continue
            if identificacion_no_coincide(invoice.get("ruc_comprador"), cli_ident):
                comprador_ajeno.append({"archivo": file.filename, "factura": invoice.get("factura_numero"),
                                        "ruc_comprador": invoice.get("ruc_comprador")})
            guardar_xml_original(supabase, user_id, client_id, "gasto", xml_content)
            result = _store_invoice(supabase, client_id, user_id, invoice)
            if result == "new":
                new_count += 1
            elif result == "duplicate":
                dup_count += 1
            else:
                err_count += 1

        if new_count:
            registrar(actor_user_id=user_id, action="upload", module="gastos",
                      entity="Facturas de gastos", client_id=client_id, cantidad=new_count)
        return {"new": new_count, "duplicates": dup_count, "errors": err_count,
                "fuera_de_periodo": fp_count, "fuera_periodo": fuera_periodo,
                "comprador_ajeno": comprador_ajeno,
                "periodo": etiqueta_periodo(pmes, panio, pfreq, psem)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/clear")
async def clear_invoices(
    client_id: Optional[str] = Query(None),
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        q = supabase.table("invoices").delete().eq("user_id", user_id)
        if client_id:
            assert_client_owner(client_id, user_id)
            q = q.eq("client_id", client_id)
        else:
            q = q.neq("id", "00000000-0000-0000-0000-000000000000")
        q.execute()
        return {"message": "Facturas eliminadas"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/bulk-move")
async def bulk_move(payload: BulkMove, user_id: str = Depends(get_current_user)):
    """Reasigna varias facturas a otro cliente. Omite las que chocarían con una
    factura ya existente (misma clave) en el cliente destino."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(payload.client_id, user_id)
        if not payload.ids:
            return {"moved": 0, "skipped": 0}
        # Verificar tenencia sobre el client_id ACTUAL de cada factura (no solo
        # el destino): filtrar por user_id de sesión hacía que mover facturas
        # de otro dueño (acceso compartido) fallara en silencio.
        ok_ids = filter_ids_by_tenancy(supabase, "invoices", payload.ids, user_id)
        if ok_ids:
            try:
                supabase.table("invoices").update({"client_id": payload.client_id}).in_("id", ok_ids).execute()
            except Exception as e:
                print(f"No se pudieron mover facturas: {e}")
                return {"moved": 0, "skipped": len(payload.ids)}
        return {"moved": len(ok_ids), "skipped": len(payload.ids) - len(ok_ids)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/bulk-delete")
async def bulk_delete(payload: BulkIds, user_id: str = Depends(get_current_user)):
    """Elimina varias facturas por id."""
    try:
        if not payload.ids:
            return {"deleted": 0}
        supabase = get_supabase_client()
        ok_ids = filter_ids_by_tenancy(supabase, "invoices", payload.ids, user_id)
        if ok_ids:
            supabase.table("invoices").delete().in_("id", ok_ids).execute()
        return {"deleted": len(ok_ids)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{invoice_id}")
async def update_invoice(
    invoice_id: str,
    update: InvoiceUpdate,
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        cur_cid = supabase.table("invoices").select("client_id").eq("id", invoice_id).execute().data
        if not cur_cid:
            raise HTTPException(status_code=404, detail="Factura no encontrada")
        assert_client_owner(cur_cid[0]["client_id"], user_id)
        update_data = {k: v for k, v in update.dict().items() if v is not None}

        # Si cambia el descuento manual, recalcular Base 15%, IVA 15% y Total
        if "desc_manual" in update_data:
            current = supabase.table("invoices").select(
                "base_15_original,base_0,base_5,iva_5,base_8,iva_8,exento_iva,no_objeto_iva"
            ).eq("id", invoice_id).execute()
            if current.data:
                row = current.data[0]
                base_15_orig = float(row.get("base_15_original") or 0)
                desc = float(update_data["desc_manual"] or 0)
                new_base_15 = max(0.0, base_15_orig - desc)
                new_iva_15 = round(new_base_15 * 0.15, 2)
                total = round(
                    float(row.get("base_0") or 0) + float(row.get("base_5") or 0)
                    + float(row.get("iva_5") or 0) + float(row.get("base_8") or 0)
                    + float(row.get("iva_8") or 0) + float(row.get("exento_iva") or 0)
                    + float(row.get("no_objeto_iva") or 0) + new_base_15 + new_iva_15,
                    2
                )
                update_data["base_15"] = round(new_base_15, 2)
                update_data["iva_15"] = new_iva_15
                update_data["total"] = total

        # Normalizar mayúsculas en clasificación
        clasif_value = None
        if "clasificacion" in update_data and update_data["clasificacion"]:
            update_data["clasificacion"] = update_data["clasificacion"].upper()
            clasif_value = update_data["clasificacion"]

        response = supabase.table("invoices").update(update_data).eq("id", invoice_id).execute()
        row = response.data[0] if response.data else None

        reclasificadas = 0
        # Clasificar por RUC: si se asignó/cambió una categoría real, (1) propagar
        # a TODAS las facturas del mismo proveedor (sin clasificar o ya clasificadas
        # con otra categoría) y (2) recordar la regla para que las importaciones
        # FUTURAS de ese RUC entren ya clasificadas.
        if row and clasif_value and clasif_value != "SIN CLASIFICAR":
            ruc = (row.get("ruc_proveedor") or "").strip()
            if ruc:
                try:
                    from routers.classification import _propagate_classification
                    reclasificadas = _propagate_classification(supabase, ruc, clasif_value, user_id)
                except Exception as prop_e:
                    print(f"Error propagando clasificacion {ruc}: {prop_e}")
                try:
                    nombre = (row.get("nombre_proveedor") or "").upper()
                    existing = supabase.table("classification_map").select("id").eq(
                        "ruc", ruc).eq("user_id", user_id).execute()
                    if existing.data:
                        supabase.table("classification_map").update(
                            {"categoria": clasif_value, "nombre_proveedor": nombre}
                        ).eq("ruc", ruc).eq("user_id", user_id).execute()
                    else:
                        supabase.table("classification_map").insert(
                            {"user_id": user_id, "ruc": ruc, "nombre_proveedor": nombre, "categoria": clasif_value}
                        ).execute()
                except Exception as map_e:
                    print(f"Error guardando regla de clasificacion {ruc}: {map_e}")

        if row is not None:
            return {**row, "reclasificadas": reclasificadas}
        return None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{invoice_id}")
async def delete_invoice(invoice_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        cur_cid = supabase.table("invoices").select("client_id").eq("id", invoice_id).execute().data
        if not cur_cid:
            raise HTTPException(status_code=404, detail="Factura no encontrada")
        assert_client_owner(cur_cid[0]["client_id"], user_id)
        supabase.table("invoices").delete().eq("id", invoice_id).execute()
        return {"message": "Deleted"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _fetch_for_export(supabase, client_id: Optional[str], user_id: str):
    def _q():
        if client_id:
            return supabase.table("invoices").select("*").eq("client_id", client_id).order("fecha", desc=True)
        return supabase.table("invoices").select("*").eq("user_id", user_id).order("fecha", desc=True)
    return fetch_all(_q)


def _client_label(supabase, client_id: Optional[str]) -> str:
    if not client_id:
        return "facturas"
    c = supabase.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute()
    if c.data:
        row = c.data[0]
        mes = str(row.get('periodo_mes') or '').zfill(2)
        anio = str(row.get('periodo_anio') or '')
        periodo = f"{anio}-{mes}" if anio and mes != '00' else ''
        label = f"{row.get('identificacion','')}_{row.get('nombre','')}"
        if periodo:
            label = f"{label}_{periodo}"
        return label.replace(" ", "_")
    return "facturas"


@router.get("/export/excel")
async def export_excel_endpoint(
    client_id: Optional[str] = Query(None),
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
        data = _fetch_for_export(supabase, client_id, user_id)
        excel_bytes = generate_excel(data)
        label = _client_label(supabase, client_id)
        return StreamingResponse(
            iter([excel_bytes]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={label}.xlsx"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/pdf")
async def export_pdf_endpoint(
    client_id: Optional[str] = Query(None),
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
        data = _fetch_for_export(supabase, client_id, user_id)
        pdf_bytes = generate_pdf(data)
        label = _client_label(supabase, client_id)
        return StreamingResponse(
            iter([pdf_bytes]),
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename={label}.pdf"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
