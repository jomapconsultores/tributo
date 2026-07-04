import xml.etree.ElementTree as ET
from typing import List, Dict
from services.ice_data import (
    buscar_en_catalogo, es_pack, get_botellas_por_caja,
)
from services.ice_anexo import _extraer_grado, _extraer_volumen
from services.xml_parser import find_node_ignore_ns as _find_node

# _text no se deduplica con find_text_ignore_ns (xml_parser.py) porque acá
# admite un parámetro `default` propio (usado por llamadas de este módulo);
# la lógica de búsqueda ignorando namespace es la misma.
def _text(parent, tag, default=""):
    node = _find_node(parent, tag)
    return node.text.strip() if (node is not None and node.text) else default


def _num(parent, tag, default=0.0):
    try:
        return float(_text(parent, tag) or default)
    except (TypeError, ValueError):
        return default


def _extraer_impuestos(impuestos_node):
    res = {'ice': 0.0, 'base_ice': 0.0, 'iva': 0.0, 'base_iva': 0.0}
    if impuestos_node is None:
        return res
    for imp in impuestos_node:
        if not imp.tag.endswith('impuesto'):
            continue
        cod = _text(imp, 'codigo')
        if cod == '3':       # ICE
            res['ice'] = _num(imp, 'valor')
            res['base_ice'] = _num(imp, 'baseImponible')
        elif cod == '2':     # IVA
            res['iva'] = _num(imp, 'valor')
            res['base_iva'] = _num(imp, 'baseImponible')
    return res


def parse_ice_invoice(xml_content: str) -> List[Dict]:
    """Parsea una factura de venta de licor. Devuelve una lista de registros
    (uno por línea de detalle que tenga ICE). Portado de ICEcompleto(1).py."""
    try:
        try:
            root = ET.fromstring(xml_content)
        except Exception:
            return []

        # Desenvolver <autorizacion><comprobante> CDATA si aplica
        comp = _find_node(root, 'comprobante')
        if comp is not None and comp.text:
            inner = comp.text.strip().replace("<![CDATA[", "").replace("]]>", "").strip()
            try:
                root = ET.fromstring(inner)
            except Exception:
                pass

        info_trib = _find_node(root, 'infoTributaria')
        info_fact = _find_node(root, 'infoFactura')
        detalles = _find_node(root, 'detalles')
        if info_fact is None or detalles is None:
            return []

        clave = _text(info_trib, 'claveAcceso')
        estab = _text(info_trib, 'estab')
        pto = _text(info_trib, 'ptoEmi')
        sec = _text(info_trib, 'secuencial')
        base_id = clave or f"{estab}-{pto}-{sec}"

        fecha = _text(info_fact, 'fechaEmision')
        tipo_id = _text(info_fact, 'tipoIdentificacionComprador')
        id_cliente = _text(info_fact, 'identificacionComprador')
        razon = _text(info_fact, 'razonSocialComprador') or 'CONSUMIDOR FINAL'
        importe_total = _num(info_fact, 'importeTotal')

        registros = []
        idx = 0
        for det in detalles:
            if not det.tag.endswith('detalle'):
                continue
            idx += 1
            cod = _text(det, 'codigoPrincipal')
            desc = _text(det, 'descripcion')
            cant = _num(det, 'cantidad')
            p_unit = _num(det, 'precioUnitario')
            p_total = _num(det, 'precioTotalSinImpuesto')

            imp = _extraer_impuestos(_find_node(det, 'impuestos'))
            if imp['ice'] <= 0:
                continue  # solo líneas con ICE (datos_ice)

            bot_por_caja = get_botellas_por_caja(desc)
            unidades = int(cant * bot_por_caja)
            pack = es_pack(desc)
            cat = buscar_en_catalogo(desc)
            # El volumen (ml) y el grado REALES están en la descripción ('375 ML', '40V');
            # el catálogo hardcodeado los traía fijos (aguardiente 750/15, etc.) y distorsionaba
            # el ICE ad-valorem (depende del precio por LITRO, o sea del volumen).
            vol_nombre = _extraer_volumen(desc)
            grado_nombre = _extraer_grado(desc)

            precio_por_caja = p_total / cant if cant > 0 else p_unit
            precio_por_botella = precio_por_caja / bot_por_caja if bot_por_caja > 0 else precio_por_caja

            registros.append({
                "unique_id": f"{base_id}-{idx}",
                "estado": "OK",
                "fecha": fecha,
                "tipo_id_cliente": tipo_id,
                "id_cliente": id_cliente,
                "razon_social_cliente": razon,
                "codigo_producto": cod,
                "nombre_producto": (desc or '')[:120],
                "cod_marca": cat['codMarca'],
                "presentacion": cat['presentacion'],
                "capacidad": vol_nombre or cat['capacidad'],
                "unidad": cat['unidad'],
                "grado_alcoholico": grado_nombre or cat['grado'],
                "cod_impuesto": cat['codImpuesto'],
                "tipo_producto": cat['tipo'],
                "es_pack": pack,
                "botellas_por_caja": bot_por_caja,
                "cantidad_cajas": round(cant, 2),
                "unidades_botellas": unidades,
                "precio_unitario": round(p_unit, 4),
                "precio_total_sin_impuesto": round(p_total, 2),
                "precio_por_caja": round(precio_por_caja, 4),
                "precio_por_botella": round(precio_por_botella, 4),
                "base_ice": round(imp['base_ice'], 2),
                "valor_ice": round(imp['ice'], 2),
                "base_iva": round(imp['base_iva'], 2),
                "valor_iva": round(imp['iva'], 2),
                "importe_total": round(importe_total, 2),
            })
        return registros
    except Exception as e:
        print(f"Error parseando factura ICE: {e}")
        return []
