import xml.etree.ElementTree as ET
from typing import Dict, Optional
from datetime import datetime

GASTOS_PERSONALES = {
    "ALIMENTACIÓN", "ALIMENTACION", "EDUCACIÓN", "EDUCACION",
    "SALUD", "VESTIMENTA", "VIVIENDA", "VARIOS", "TURISMO", "ARTE Y CULTURA"
}

def find_text_ignore_ns(parent, tag_name: str) -> str:
    """Busca texto en elemento ignorando namespace"""
    if parent is None:
        return ""
    node = parent.find(tag_name)
    if node is not None and node.text:
        return node.text.strip()
    for element in parent.iter():
        if element.tag.endswith(f"}}{tag_name}") or element.tag == tag_name:
            if element.text:
                return element.text.strip()
    return ""

def find_node_ignore_ns(parent, tag_name: str):
    """Busca nodo ignorando namespace"""
    if parent is None:
        return None
    for element in parent.iter():
        if element.tag.endswith(f"}}{tag_name}") or element.tag == tag_name:
            return element
    return None

def parse_xml_invoice(
    xml_content: str,
    classification_map: Dict[str, str],
    card_memory: Dict[str, str] = None
) -> Optional[Dict]:
    """Parsea una factura XML del SRI"""
    if card_memory is None:
        card_memory = {}

    try:
        try:
            root = ET.fromstring(xml_content)
        except:
            return None

        comprobante_node = find_node_ignore_ns(root, 'comprobante')
        if comprobante_node is not None and comprobante_node.text:
            inner_xml = comprobante_node.text.strip()
            inner_xml = inner_xml.replace("<![CDATA[", "").replace("]]>", "").strip()
            try:
                root = ET.fromstring(inner_xml)
            except:
                pass

        info_tributaria = find_node_ignore_ns(root, 'infoTributaria')
        info_factura = find_node_ignore_ns(root, 'infoFactura')
        if info_tributaria is None and info_factura is None:
            return None

        # Datos básicos
        clave_acceso = find_text_ignore_ns(info_tributaria, 'claveAcceso')
        ruc = find_text_ignore_ns(info_tributaria, 'ruc')
        ruc_comprador = find_text_ignore_ns(info_factura, 'identificacionComprador')

        estab = find_text_ignore_ns(info_tributaria, 'estab')
        pto_emi = find_text_ignore_ns(info_tributaria, 'ptoEmi')
        secuencial = find_text_ignore_ns(info_tributaria, 'secuencial')
        factura_numero = f"{estab}-{pto_emi}-{secuencial}"
        unique_id = clave_acceso if clave_acceso else f"{ruc}-{factura_numero}"

        fecha = find_text_ignore_ns(info_factura, 'fechaEmision')
        nombre = find_text_ignore_ns(info_tributaria, 'razonSocial')
        destinatario = find_text_ignore_ns(info_factura, 'razonSocialComprador')

        clasificacion = classification_map.get(ruc, "SIN CLASIFICAR")

        # Forma de pago
        pagos = find_node_ignore_ns(info_factura, 'pagos')
        forma_pago = "Otros"
        if pagos is not None:
            pago = find_node_ignore_ns(pagos, 'pago')
            if pago is not None:
                cod_pago = find_text_ignore_ns(pago, 'formaPago')
                if cod_pago == '01':
                    forma_pago = "Sin Utilización del Sistema Financiero"
                elif cod_pago == '19':
                    forma_pago = "Tarjeta de Crédito"
                elif cod_pago == '20':
                    forma_pago = "Otros con Utilización del Sistema Financiero"
                else:
                    forma_pago = f"Código {cod_pago}"

        # Concepto
        detalles = find_node_ignore_ns(root, 'detalles')
        concepto_str = "VARIOS"
        if detalles is not None:
            lista_detalles = list(detalles)
            for child in lista_detalles:
                if child.tag.endswith('detalle'):
                    desc = find_text_ignore_ns(child, 'descripcion')
                    if desc:
                        concepto_str = desc
                        if len(lista_detalles) > 1:
                            concepto_str += "..."
                        break

        # Descuentos
        try:
            total_descuento_xml = float(find_text_ignore_ns(info_factura, 'totalDescuento') or 0)
        except:
            total_descuento_xml = 0.0

        # Bases e impuestos
        base_0, base_15, iva_15 = 0.0, 0.0, 0.0
        base_5, iva_5 = 0.0, 0.0
        base_exento, base_no_objeto = 0.0, 0.0

        total_con_impuestos = find_node_ignore_ns(info_factura, 'totalConImpuestos')
        if total_con_impuestos is not None:
            for impuesto in total_con_impuestos:
                codigo = find_text_ignore_ns(impuesto, 'codigo')
                if codigo == '2':  # IVA
                    cod_porc = find_text_ignore_ns(impuesto, 'codigoPorcentaje')
                    try:
                        base_imponible = float(find_text_ignore_ns(impuesto, 'baseImponible') or 0)
                    except:
                        base_imponible = 0.0
                    try:
                        valor_impuesto = float(find_text_ignore_ns(impuesto, 'valor') or 0)
                    except:
                        valor_impuesto = 0.0

                    if cod_porc == '0':
                        base_0 += base_imponible
                    elif cod_porc in ['2', '3', '4', '10']:
                        base_15 += base_imponible
                        iva_15 += valor_impuesto
                    elif cod_porc == '5':
                        base_5 += base_imponible
                        iva_5 += valor_impuesto
                    elif cod_porc == '6':
                        base_no_objeto += base_imponible
                    elif cod_porc == '7':
                        base_exento += base_imponible

        try:
            total = float(find_text_ignore_ns(info_factura, 'importeTotal') or 0)
        except:
            total = 0.0

        # Valores originales (antes de aplicar cualquier descuento)
        base_15_original = round(base_15, 2)
        total_original = round(total, 2)

        # Regla Yanbal: el descuento del XML se resta de la Base 15% SOLO para
        # proveedores Yanbal; en los demás el descuento queda informativo.
        es_yanbal = "YANBAL" in (nombre or "").upper()
        if es_yanbal and total_descuento_xml > 0:
            base_15 = max(0.0, base_15_original - total_descuento_xml)
            iva_15 = round(base_15 * 0.15, 2)
            total = round(
                base_0 + base_5 + iva_5 + base_exento + base_no_objeto + base_15 + iva_15,
                2
            )

        # Memoria de tarjeta
        mem_key = f"{nombre}|{total_original:.2f}"
        tarjeta_credito = card_memory.get(mem_key, "")

        return {
            "unique_id": unique_id,
            "estado": "OK",
            "fecha": fecha,
            "ruc_proveedor": ruc,
            "factura_numero": factura_numero,
            "nombre_proveedor": nombre,
            "clasificacion": clasificacion,
            "concepto": concepto_str,
            "forma_pago": forma_pago,
            "tarjeta_credito": tarjeta_credito,
            "no_objeto_iva": round(base_no_objeto, 2),
            "exento_iva": round(base_exento, 2),
            "base_0": round(base_0, 2),
            "base_15": round(base_15, 2),
            "iva_15": round(iva_15, 2),
            "base_5": round(base_5, 2),
            "iva_5": round(iva_5, 2),
            "desc_info": round(total_descuento_xml, 2),
            "desc_manual": 0.00,
            "total": round(total, 2),
            "destinatario": destinatario,
            "ruc_comprador": ruc_comprador,
            "xml_content": xml_content,
            "base_15_original": base_15_original,
            "total_original": total_original,
            "es_yanbal": es_yanbal
        }
    except Exception as e:
        print(f"Error parseando XML: {e}")
        return None
