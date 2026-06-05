"""Generación del anexo ICE para el SRI y agrupaciones por producto / cliente.
Portado de la lógica de ICEcompleto(1).py (sincronizar_editor + generar_xml)."""
from collections import defaultdict, OrderedDict
from xml.sax.saxutils import escape
from services.ice_data import buscar_en_catalogo

# tipoIdentificacionComprador (factura) → tipoIdCliente (anexo ICE)
_TIPO_ID = {'04': 'R', '05': 'C', '06': 'P', '07': 'F', '08': 'F'}


def _map_tipo_id(t):
    return _TIPO_ID.get(str(t or '').strip(), 'F')


def _resolver_cod_prod_ice(nombre_producto):
    """Devuelve (codProdICE, reconocido)."""
    cat = buscar_en_catalogo(nombre_producto)
    cod_sri = (cat.get('codProdSRI', '') or '').strip()
    if not cod_sri:
        return cat.get('codImpuesto', '3031'), False
    if '-' in cod_sri:
        return cod_sri, True
    pres = (cat.get('presentacion', '13') or '13').zfill(3)
    cap = (cat.get('capacidad', '750') or '750').zfill(6)
    und = cat.get('unidad', '66')
    grad = (cat.get('grado', '15') or '15').zfill(6)
    cimp = cat.get('codImpuesto', '3031')
    return f"{cimp}-057-{cod_sri.zfill(6)}-{pres}-{cap}-{und}-593-{grad}", True


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def grupo_por_producto(rows):
    """Reúne productos iguales (por nombre)."""
    ag = OrderedDict()
    for r in rows:
        key = (r.get('nombre_producto') or '(sin nombre)').upper()
        a = ag.get(key)
        if not a:
            a = ag[key] = {"producto": key, "num": 0, "botellas": 0, "cajas": 0.0,
                           "base_ice": 0.0, "valor_ice": 0.0, "base_iva": 0.0,
                           "valor_iva": 0.0, "total": 0.0}
        a["num"] += 1
        a["botellas"] += int(_f(r.get("unidades_botellas")))
        a["cajas"] += _f(r.get("cantidad_cajas"))
        a["base_ice"] += _f(r.get("base_ice"))
        a["valor_ice"] += _f(r.get("valor_ice"))
        a["base_iva"] += _f(r.get("base_iva"))
        a["valor_iva"] += _f(r.get("valor_iva"))
        a["total"] += _f(r.get("importe_total"))
    return [{**v, **{k: round(v[k], 2) for k in ("cajas", "base_ice", "valor_ice", "base_iva", "valor_iva", "total")}}
            for v in ag.values()]


def grupo_por_cliente(rows):
    """Reúne por cliente comprador (RUC + nombre)."""
    ag = OrderedDict()
    for r in rows:
        ruc = r.get("id_cliente") or ""
        key = ruc
        a = ag.get(key)
        if not a:
            a = ag[key] = {"ruc": ruc, "nombre": r.get("razon_social_cliente") or "", "num": 0,
                           "botellas": 0, "base_ice": 0.0, "valor_ice": 0.0,
                           "valor_iva": 0.0, "total": 0.0}
        a["num"] += 1
        a["botellas"] += int(_f(r.get("unidades_botellas")))
        a["base_ice"] += _f(r.get("base_ice"))
        a["valor_ice"] += _f(r.get("valor_ice"))
        a["valor_iva"] += _f(r.get("valor_iva"))
        a["total"] += _f(r.get("importe_total"))
    return [{**v, **{k: round(v[k], 2) for k in ("base_ice", "valor_ice", "valor_iva", "total")}}
            for v in ag.values()]


def _build_vtas(rows):
    """Agrupa ventas por (idCliente, codProdICE). Devuelve (lista_vtas, advertencias)."""
    dedup = OrderedDict()
    no_reconocidos = set()
    for r in rows:
        idc = r.get("id_cliente") or ""
        cod_ice, ok = _resolver_cod_prod_ice(r.get("nombre_producto"))
        if not ok:
            no_reconocidos.add((r.get("nombre_producto") or "")[:80])
        clave = (idc, cod_ice)
        ent = dedup.get(clave)
        bottles = int(_f(r.get("unidades_botellas")))
        if ent:
            ent["ventaICE"] += bottles
        else:
            dedup[clave] = {
                "codProdICE": cod_ice,
                "gramoAzucar": "0.00",
                "tipoIdCliente": _map_tipo_id(r.get("tipo_id_cliente")),
                "idCliente": idc,
                "tipoVentaICE": "1",
                "ventaICE": bottles,
                "devICE": "0",
                "cantProdBajaICE": "0",
            }
    advertencias = []
    if no_reconocidos:
        advertencias.append(
            "Productos sin código SRI (usarán '3031', inválido para el SRI): "
            + "; ".join(sorted(p for p in no_reconocidos if p))
        )
    return list(dedup.values()), advertencias


def anexo_rows(rows, contribuyente, anio, mes, act_import="02"):
    """Filas del anexo ICE listas para editar en el editor."""
    vtas, advertencias = _build_vtas(rows)
    for v in vtas:
        v["ventaICE"] = str(v["ventaICE"])
    c = contribuyente or {}
    header = {
        "TipoIDInformante": "R",
        "IdInformante": c.get("identificacion", ""),
        "razonSocial": c.get("nombre", ""),
        "Anio": str(anio),
        "Mes": str(mes).zfill(2),
        "actImport": str(act_import)[:2],
        "codigoOperativo": "ICE",
    }
    return {"tipo": "ICE", "header": header, "rows": vtas, "advertencias": advertencias}


def catalogo_con_codigos():
    """Catálogo de productos con su codProdICE resuelto, para insertar en el anexo."""
    from services.ice_data import CATALOGO_BASE
    out = []
    for nombre, d in CATALOGO_BASE.items():
        cod_ice, ok = _resolver_cod_prod_ice(nombre)
        out.append({
            "nombre": nombre,
            "codProdSRI": d.get("codProdSRI", ""),
            "codProdICE": cod_ice if ok else "",
            "capacidad": d.get("capacidad", ""),
            "grado": d.get("grado", ""),
        })
    return out


def generar_anexo_ice(rows, contribuyente, anio, mes, act_import="02"):
    """Genera el XML del anexo ICE. Agrupa ventas por idCliente + codProdICE.
    Devuelve {xml, ventas, advertencias}."""
    vtas, no_reconocidos_adv = _build_vtas(rows)
    dedup = {(v["idCliente"], v["codProdICE"]): v for v in vtas}

    mes_str = str(mes).zfill(2)
    ruc = (contribuyente or {}).get("identificacion", "")
    razon = (contribuyente or {}).get("nombre", "")

    cols = ['codProdICE', 'gramoAzucar', 'tipoIdCliente', 'idCliente',
            'tipoVentaICE', 'ventaICE', 'devICE', 'cantProdBajaICE']

    lines = ['<?xml version="1.0" encoding="UTF-8" standalone="no"?>']
    lines.append('<ice>')
    lines.append(f'  <TipoIDInformante>R</TipoIDInformante>')
    lines.append(f'  <IdInformante>{escape(ruc)}</IdInformante>')
    lines.append(f'  <razonSocial>{escape(razon)}</razonSocial>')
    lines.append(f'  <Anio>{escape(str(anio))}</Anio>')
    lines.append(f'  <Mes>{escape(mes_str)}</Mes>')
    lines.append(f'  <actImport>{escape(str(act_import)[:2])}</actImport>')
    lines.append('  <codigoOperativo>ICE</codigoOperativo>')
    lines.append('  <ventas>')
    for e in dedup.values():
        lines.append('    <vta>')
        for c in cols:
            lines.append(f'      <{c}>{escape(str(e[c]))}</{c}>')
        lines.append('    </vta>')
    lines.append('  </ventas>')
    lines.append('</ice>')

    return {"xml": "\n".join(lines), "ventas": len(dedup), "advertencias": no_reconocidos_adv}
