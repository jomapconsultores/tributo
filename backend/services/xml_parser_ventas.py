"""Parser de XMLs de facturas de VENTA (ingresos) SIN ICE.

A diferencia de:
- xml_parser.parse_xml_invoice: facturas de gasto (compras del contribuyente).
- ice_parser.parse_ice_invoice: facturas de venta CON ICE (desagregadas por detalle).

Esta función procesa facturas de venta SIN ICE y devuelve un resumen por factura
(no por línea), porque sin ICE no se necesita desagregar.

Si detecta cualquier <impuesto><codigo>3</codigo></impuesto> (ICE), rechaza la
factura — el usuario debería usar el módulo ICE-XML en su lugar.
"""
import xml.etree.ElementTree as ET
from typing import Dict, Optional

from .xml_parser import find_text_ignore_ns, find_node_ignore_ns


# Códigos de codigoPorcentaje del SRI para IVA (codigo=2):
#   0    → 0%
#   2,3,4,10 → 15% (varios SKUs históricos: 14%, 15%, etc.)
#   5    → 5%
#   6    → no objeto de IVA
#   7    → exento de IVA
TARIFA_15 = {'2', '3', '4', '10'}


def parse_venta_xml(xml_content: str) -> Optional[Dict]:
    """Devuelve dict con resumen de la factura de venta, o dict con 'error'
    si la factura tiene ICE (debe ir al módulo ICE-XML), o None si el XML
    no se puede parsear."""
    try:
        try:
            root = ET.fromstring(xml_content)
        except Exception:
            return None

        # Desenvolver <comprobante> CDATA si existe
        comp = find_node_ignore_ns(root, 'comprobante')
        if comp is not None and comp.text:
            inner = comp.text.strip().replace("<![CDATA[", "").replace("]]>", "").strip()
            try:
                root = ET.fromstring(inner)
            except Exception:
                pass

        info_trib = find_node_ignore_ns(root, 'infoTributaria')
        info_fact = find_node_ignore_ns(root, 'infoFactura')
        if info_trib is None or info_fact is None:
            return None

        # Identificadores
        clave_acceso = find_text_ignore_ns(info_trib, 'claveAcceso')
        ruc_emisor = find_text_ignore_ns(info_trib, 'ruc')
        estab = find_text_ignore_ns(info_trib, 'estab')
        pto = find_text_ignore_ns(info_trib, 'ptoEmi')
        sec = find_text_ignore_ns(info_trib, 'secuencial')
        factura_numero = f"{estab}-{pto}-{sec}"
        unique_id = clave_acceso or f"{ruc_emisor}-{factura_numero}"

        # Cliente (comprador de la factura)
        fecha = find_text_ignore_ns(info_fact, 'fechaEmision')
        tipo_id_cliente = find_text_ignore_ns(info_fact, 'tipoIdentificacionComprador')
        id_cliente = find_text_ignore_ns(info_fact, 'identificacionComprador')
        razon_cliente = find_text_ignore_ns(info_fact, 'razonSocialComprador') or 'CONSUMIDOR FINAL'

        # ── RECHAZO si tiene ICE ────────────────────────────────────────
        # El SRI declara ICE tanto en <detalles><detalle><impuestos> como en
        # <totalConImpuestos>. Revisamos ambos.
        ice_detected = False

        detalles = find_node_ignore_ns(root, 'detalles')
        if detalles is not None:
            for det in detalles:
                if not det.tag.endswith('detalle'):
                    continue
                imps = find_node_ignore_ns(det, 'impuestos')
                if imps is not None:
                    for imp in imps:
                        cod = find_text_ignore_ns(imp, 'codigo')
                        if cod == '3':
                            ice_detected = True
                            break
                if ice_detected:
                    break

        total_con_imp = find_node_ignore_ns(info_fact, 'totalConImpuestos')
        if not ice_detected and total_con_imp is not None:
            for imp in total_con_imp:
                cod = find_text_ignore_ns(imp, 'codigo')
                if cod == '3':
                    ice_detected = True
                    break

        if ice_detected:
            return {
                'error': 'CON_ICE',
                'message': 'La factura contiene ICE. Subila en "ICE - XML" en vez de "Ingresos IVA".',
                'unique_id': unique_id,
                'factura_numero': factura_numero,
            }

        # ── Desglose por tarifa IVA ─────────────────────────────────────
        base_0 = base_15 = iva_15 = base_5 = iva_5 = 0.0
        no_objeto = exento = 0.0

        if total_con_imp is not None:
            for imp in total_con_imp:
                cod = find_text_ignore_ns(imp, 'codigo')
                if cod != '2':  # No es IVA → ignorar
                    continue
                cod_porc = find_text_ignore_ns(imp, 'codigoPorcentaje')
                try:
                    base = float(find_text_ignore_ns(imp, 'baseImponible') or 0)
                except ValueError:
                    base = 0.0
                try:
                    valor = float(find_text_ignore_ns(imp, 'valor') or 0)
                except ValueError:
                    valor = 0.0

                if cod_porc == '0':
                    base_0 += base
                elif cod_porc in TARIFA_15:
                    base_15 += base
                    iva_15 += valor
                elif cod_porc == '5':
                    base_5 += base
                    iva_5 += valor
                elif cod_porc == '6':
                    no_objeto += base
                elif cod_porc == '7':
                    exento += base

        try:
            importe_total = float(find_text_ignore_ns(info_fact, 'importeTotal') or 0)
        except ValueError:
            importe_total = 0.0

        return {
            'unique_id': unique_id,
            'estado': 'OK',
            'fecha': fecha,
            'tipo_id_cliente': tipo_id_cliente,
            'id_cliente': id_cliente,
            'razon_social_cliente': razon_cliente,
            'factura_numero': factura_numero,
            'no_objeto_iva': round(no_objeto, 2),
            'exento_iva': round(exento, 2),
            'base_0': round(base_0, 2),
            'base_15': round(base_15, 2),
            'iva_15': round(iva_15, 2),
            'base_5': round(base_5, 2),
            'iva_5': round(iva_5, 2),
            'importe_total': round(importe_total, 2),
        }
    except Exception:
        return None
