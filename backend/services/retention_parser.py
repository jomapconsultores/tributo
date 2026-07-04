import xml.etree.ElementTree as ET
from typing import Dict, Optional

from .xml_parser import find_text_ignore_ns, find_node_ignore_ns


def parse_retention_xml(xml_content: str) -> Optional[Dict]:
    """Parsea un comprobante de retención del SRI. Portado de Retenciones.py
    (sin la interfaz gráfica), recibe el contenido XML como string."""
    try:
        try:
            root = ET.fromstring(xml_content)
        except Exception:
            return None

        # Si viene envuelto en <autorizacion><comprobante> (CDATA)
        comprobante_node = find_node_ignore_ns(root, 'comprobante')
        if comprobante_node is not None and comprobante_node.text:
            inner_xml = comprobante_node.text.strip().replace("<![CDATA[", "").replace("]]>", "").strip()
            try:
                root = ET.fromstring(inner_xml)
            except Exception:
                pass

        info_tributaria = find_node_ignore_ns(root, 'infoTributaria')
        info_retencion = find_node_ignore_ns(root, 'infoCompRetencion')
        if info_tributaria is None:
            return None

        clave_acceso = find_text_ignore_ns(info_tributaria, 'claveAcceso')
        ruc_emisor = find_text_ignore_ns(info_tributaria, 'ruc')
        razon_social = find_text_ignore_ns(info_tributaria, 'razonSocial')
        estab = find_text_ignore_ns(info_tributaria, 'estab')
        pto_emi = find_text_ignore_ns(info_tributaria, 'ptoEmi')
        secuencial = find_text_ignore_ns(info_tributaria, 'secuencial')
        numero_completo = f"{estab}-{pto_emi}-{secuencial}"

        fecha_emision = find_text_ignore_ns(info_retencion, 'fechaEmision')
        periodo_fiscal = find_text_ignore_ns(info_retencion, 'periodoFiscal')
        ruc_sujeto = find_text_ignore_ns(info_retencion, 'identificacionSujetoRetenido')

        acc = {
            "base_renta": 0.0, "porc_renta": 0.0, "ret_renta": 0.0,
            "base_iva": 0.0, "porc_iva": 0.0, "ret_iva": 0.0,
            "ret_isd": 0.0, "total_retenido": 0.0,
        }

        def procesar_impuesto(nodo):
            try:
                codigo = find_text_ignore_ns(nodo, 'codigo')
                base = float(find_text_ignore_ns(nodo, 'baseImponible') or 0)
                try:
                    porcentaje = float(find_text_ignore_ns(nodo, 'porcentajeRetener') or 0)
                except Exception:
                    porcentaje = 0.0
                valor = float(find_text_ignore_ns(nodo, 'valorRetenido') or 0)

                acc["total_retenido"] += valor
                if codigo == '1':       # Renta
                    acc["base_renta"] += base
                    acc["ret_renta"] += valor
                    if base > 0:
                        acc["porc_renta"] = porcentaje
                elif codigo == '2':     # IVA
                    acc["base_iva"] += base
                    acc["ret_iva"] += valor
                    if base > 0:
                        acc["porc_iva"] = porcentaje
                elif codigo == '6':     # ISD
                    acc["ret_isd"] += valor
            except Exception:
                pass

        # Estrategia mixta (formato V1 y V2)
        impuestos_node = find_node_ignore_ns(root, 'impuestos')
        if impuestos_node is not None:
            for imp in impuestos_node.iter():
                if imp.tag.endswith('impuesto'):
                    procesar_impuesto(imp)

        docs_sustento = find_node_ignore_ns(root, 'docsSustento')
        if docs_sustento is not None:
            for doc in docs_sustento:
                retenciones_group = find_node_ignore_ns(doc, 'retenciones')
                if retenciones_group is not None:
                    for ret in retenciones_group:
                        if ret.tag.endswith('retencion'):
                            procesar_impuesto(ret)

        return {
            "unique_id": clave_acceso or f"{ruc_emisor}-{numero_completo}",
            "estado": "OK",
            "fecha": fecha_emision,
            "ruc_emisor": ruc_emisor,
            "agente_retencion": razon_social,
            "nro_comprobante": numero_completo,
            "periodo_fiscal": periodo_fiscal,
            "base_renta": round(acc["base_renta"], 2),
            "porc_renta": acc["porc_renta"],
            "ret_renta": round(acc["ret_renta"], 2),
            "base_iva": round(acc["base_iva"], 2),
            "porc_iva": acc["porc_iva"],
            "ret_iva": round(acc["ret_iva"], 2),
            "ret_isd": round(acc["ret_isd"], 2),
            "total_retenido": round(acc["total_retenido"], 2),
            "ruc_sujeto": ruc_sujeto,
        }
    except Exception as e:
        print(f"Error parseando retención: {e}")
        return None
