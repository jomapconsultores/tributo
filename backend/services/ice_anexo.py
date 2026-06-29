"""Generación del anexo ICE para el SRI y agrupaciones por producto / cliente.
Portado de la lógica de ICEcompleto(1).py (sincronizar_editor + generar_xml)."""
import re
import unicodedata
from collections import defaultdict, OrderedDict
from xml.sax.saxutils import escape
from services.ice_data import buscar_en_catalogo, es_pack, descomponer_pack


def _sin_tildes(s):
    """El validador del SRI rechaza vocales con tilde/diéresis; la Ñ sí es válida."""
    s = str(s or '').replace('Ñ', '\x00').replace('ñ', '\x01')
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')
    return s.replace('\x00', 'Ñ').replace('\x01', 'ñ')

# tipoIdentificacionComprador (factura) → tipoIdCliente (anexo ICE).
# Ficha técnica SRI Anexo ICE: RUC=R, CEDULA=C, PASAPORTE=P, CONSUMIDOR FINAL=F.
_TIPO_ID = {'04': 'R', '05': 'C', '06': 'P', '07': 'F', '08': 'F'}


def _map_tipo_id(t):
    return _TIPO_ID.get(str(t or '').strip(), 'F')


# Palabras de empaque/medida que no forman parte de la marca en el catálogo SRI
_PALABRAS_GENERICAS = {
    'CAJA', 'CAJAS', 'PACK', 'SIXPACK', 'BOTELLA', 'BOTELLAS',
    'UNIDAD', 'UNIDADES', 'FUNDA', 'FUNDAS', 'DE', 'X', 'U',
}


def _extraer_capacidad_ml(nombre):
    """Capacidad en ml desde la descripción ('750 ML', '1 LT', '0.75 L')."""
    s = (nombre or '').upper()
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*(?:ML|CC)\b', s)
    if m:
        return str(int(float(m.group(1).replace(',', '.'))))
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*(?:LTS?|LITROS?|L)\b', s)
    if m:
        return str(int(float(m.group(1).replace(',', '.')) * 1000))
    return None


def _extraer_grado(nombre):
    """Grado alcohólico desde la descripción ('40V', '40°', '40 GL', '40 GRADOS')."""
    s = (nombre or '').upper()
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*(?:V|°|G\.?L\.?|GRADOS?)\b', s)
    if m:
        return str(int(float(m.group(1).replace(',', '.'))))
    return None


def _extraer_volumen(nombre):
    """Volumen (ml) desde la descripción ('750 ML', '375ML', '0.75 L', '80 CC')."""
    s = (nombre or '').upper()
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*(ML|CC)\b', s)
    if m:
        return str(int(float(m.group(1).replace(',', '.'))))
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*(?:LTS?|LITROS?|L)\b', s)
    if m:
        return str(int(float(m.group(1).replace(',', '.')) * 1000))
    return None


def _limpiar_nombre(nombre):
    """Quita empaque, medidas y números para quedarse con la marca:
    'CAJA WHISKY RED DIEZ 40V 750 ML (12U)' → 'WHISKY RED DIEZ'."""
    s = (nombre or '').upper()
    s = re.sub(r'\([^)]*\)', ' ', s)
    s = re.sub(r'\d+(?:[.,]\d+)?\s*(?:ML|CC|LTS?|LITROS?|L|V|°|G\.?L\.?|GRADOS?|U)\b', ' ', s)
    s = re.sub(r'\b\d+(?:[.,]\d+)?\b', ' ', s)
    palabras = [p for p in re.split(r'[^A-ZÁÉÍÓÚÜÑ]+', s) if p and p not in _PALABRAS_GENERICAS]
    return ' '.join(palabras)


def _armar_codigo(cimp, clasif, marca, pres, cap, und, pais, grado):
    """Código completo: impuesto-clasificación-marca-presentación-capacidad-unidad-país-grado."""
    return (f"{cimp}-{str(clasif).zfill(3)}-{str(marca).zfill(6)}-{str(pres).zfill(3)}-"
            f"{str(cap).zfill(6)}-{und}-{pais}-{str(grado).zfill(6)}")


def _buscar_codigo_oficial(nombre_producto, buscar_oficial):
    """Busca la marca en el catálogo oficial de Códigos ICE (BD ice_codigos /
    archivo). Exige que TODAS las palabras del nombre limpio aparezcan en la
    descripción oficial (en cualquier orden: 'WHISKY RED DIEZ' encuentra
    'RED DIEZ WHISKY') y elige la marca con menos palabras sobrantes. Para
    nombres de una sola palabra solo acepta coincidencia exacta."""
    limpio = _limpiar_nombre(nombre_producto)
    tokens = limpio.split()
    if not tokens:
        return None
    try:
        res = buscar_oficial(limpio) or []
    except Exception:
        return None
    qset = set(tokens)
    candidatos = []
    for d in res:
        dtok = {t for t in re.split(r'[^A-ZÁÉÍÓÚÜÑ0-9]+', (d.get('descripcion') or '').upper()) if t}
        if qset <= dtok:
            candidatos.append((len(dtok - qset), d))
    if len(tokens) == 1:
        candidatos = [c for c in candidatos if c[0] == 0]
    if not candidatos:
        return None
    candidatos.sort(key=lambda c: c[0])
    return candidatos[0][1]


_RUIDO_ANEXO = {"CAJA", "PACK", "DUO", "TRIO", "MULTI", "MEGA", "BOTELLA", "BOTELLAS",
                "UNIDAD", "UNIDADES", "ML", "CC", "LT", "DE", "DEL", "LA", "EL", "LOS",
                "CON", "Y", "A", "SABOR", "CORP", "BAJO", "ALCOHOLICO", "ALCOHOLICA",
                "CONTENIDO", "BEBIDA", "GRADO"}


def _tokens_anexo(nombre):
    s = unicodedata.normalize("NFKD", str(nombre or "")).encode("ascii", "ignore").decode().upper()
    return {t for t in re.split(r"[^A-Z0-9]+", s) if len(t) >= 3 and not t.isdigit() and t not in _RUIDO_ANEXO}


def _match_catalogo_palabras(nombre, catalogo, vol_hint=None):
    """Empareja el producto con el catálogo del cliente por mayor coincidencia de
    palabras (desempate por capacidad). Devuelve el PRODUCTO del catálogo o None."""
    stoks = _tokens_anexo(nombre)
    if not stoks:
        return None
    best, best_score = None, 0.0
    for p in catalogo:
        if not (p.get("cod_prod_ice") or "").strip():
            continue
        comunes = len(_tokens_anexo(p.get("nombre")) & stoks)
        if comunes == 0:
            continue
        score = comunes
        cap = str(p.get("capacidad") or "").strip()
        if vol_hint and cap and cap == str(vol_hint).strip():
            score += 0.5
        if score > best_score:
            best_score, best = score, p
    return best if best_score >= 2 else None


def _ajustar_cod(cod, nombre):
    """El codProdICE del SRI lleva la capacidad y el grado REALES del producto (los del
    nombre: '750ML'→capacidad, '15V'→grado). El catálogo del cliente a veces guarda esos
    segmentos codificados (ej. grado 049) que el SRI NO reconoce y rechaza el detalle."""
    if not cod or cod.count('-') != 7:
        return cod
    seg = cod.split('-')
    # Clasificación de bebidas alcohólicas = 057 (el catálogo a veces trae 049/018 mal).
    if seg[0] == '3031':
        seg[1] = '057'
    cap = _extraer_volumen(nombre)
    grado = _extraer_grado(nombre)
    if cap:
        seg[4] = str(int(float(cap))).zfill(6)
    if grado:
        seg[7] = str(int(float(grado))).zfill(6)
    return '-'.join(seg)


def _resolver_cod_prod_ice(nombre_producto, catalogo_cliente=None, buscar_oficial=None):
    """Devuelve (codProdICE, reconocido). Orden: catálogo del cliente (nombre exacto,
    luego por palabras+capacidad) → catálogo base → catálogo oficial de Códigos ICE."""
    desc = (nombre_producto or "").upper()
    if catalogo_cliente:
        for p in catalogo_cliente:
            pn = (p.get("nombre") or "").upper().strip()
            cod = (p.get("cod_prod_ice") or "").strip()
            if pn and cod and (pn in desc or desc in pn):
                return _ajustar_cod(cod, nombre_producto), True
        p = _match_catalogo_palabras(nombre_producto, catalogo_cliente, _extraer_volumen(nombre_producto))
        if p and (p.get("cod_prod_ice") or "").strip():
            return _ajustar_cod(p["cod_prod_ice"].strip(), nombre_producto), True
    cat = buscar_en_catalogo(nombre_producto)
    cod_sri = (cat.get('codProdSRI', '') or '').strip()
    if cod_sri:
        if '-' in cod_sri:
            return cod_sri, True
        # Capacidad y grado REALES del nombre (ej. componente de pack '... 375ML 15V');
        # si no están, los del catálogo base.
        cap = _extraer_volumen(nombre_producto) or cat.get('capacidad', '750') or '750'
        grado = _extraer_grado(nombre_producto) or cat.get('grado', '15') or '15'
        return _armar_codigo(
            cat.get('codImpuesto', '3031'), '057', cod_sri,
            cat.get('presentacion', '13') or '13', cap,
            cat.get('unidad', '66'), '593', grado), True
    if buscar_oficial:
        of = _buscar_codigo_oficial(nombre_producto, buscar_oficial)
        if of and (of.get('marca') or '').strip():
            return _armar_codigo(
                of.get('impuesto') or '3031', of.get('clasif_cod') or '57',
                of['marca'].strip(),
                '13', _extraer_capacidad_ml(nombre_producto) or '750',
                '66', '593', _extraer_grado(nombre_producto) or '15'), True
    return cat.get('codImpuesto', '3031'), False


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


def _build_vtas(rows, catalogo_cliente=None, buscar_oficial=None):
    """Agrupa ventas por (idCliente, codProdICE). Devuelve (lista_vtas, advertencias)."""
    dedup = OrderedDict()
    no_reconocidos = set()
    cache = {}
    for r in rows:
        idc = r.get("id_cliente") or ""
        nombre = r.get("nombre_producto") or ""
        cajas = int(_f(r.get("cantidad_cajas")))
        # Los PACKS se DIVIDEN en sus componentes: cada uno va al SRI con su propio
        # codProdICE y sus botellas (G=1 bot/caja × cajas). No hay descuento de ICE.
        if es_pack(nombre):
            grado = _extraer_grado(nombre) or "15"
            componentes = [(f"{cn} {grado}V {cc}ML", cajas) for cn, cc in descomponer_pack(nombre)]
        else:
            componentes = [(nombre, int(_f(r.get("unidades_botellas"))))]

        for comp_nombre, bottles in componentes:
            if comp_nombre in cache:
                cod_ice, ok = cache[comp_nombre]
            else:
                cod_ice, ok = _resolver_cod_prod_ice(comp_nombre, catalogo_cliente, buscar_oficial)
                cache[comp_nombre] = (cod_ice, ok)
            if not ok:
                no_reconocidos.add(comp_nombre[:80])
            clave = (idc, cod_ice)
            ent = dedup.get(clave)
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
                    "nombreProducto": comp_nombre,
                }
    advertencias = []
    if no_reconocidos:
        advertencias.append(
            "Productos sin código SRI (usarán '3031', inválido para el SRI): "
            + "; ".join(sorted(p for p in no_reconocidos if p))
        )
    return list(dedup.values()), advertencias


def _resolver_cod_prod_pvp(nombre_producto, catalogo_cliente=None, buscar_oficial=None):
    """Devuelve (codProdPVP, reconocido). El código PVP es el código individual
    de la marca (no el compuesto): catálogo del cliente → base → oficial."""
    desc = (nombre_producto or "").upper()
    if catalogo_cliente:
        for p in catalogo_cliente:
            pn = (p.get("nombre") or "").upper().strip()
            cod = (p.get("cod_prod_pvp") or p.get("cod_prod_ice") or "").strip()
            if pn and cod and (pn in desc or desc in pn):
                return cod.split('-')[2].lstrip('0') if cod.count('-') == 7 else cod, True
        p = _match_catalogo_palabras(nombre_producto, catalogo_cliente, _extraer_volumen(nombre_producto))
        if p:
            cod = (p.get("cod_prod_pvp") or p.get("cod_prod_ice") or "").strip()
            if cod:
                return cod.split('-')[2].lstrip('0') if cod.count('-') == 7 else cod, True
    cat = buscar_en_catalogo(nombre_producto)
    cod_sri = (cat.get('codProdSRI', '') or '').strip()
    if cod_sri:
        return cod_sri, True
    if buscar_oficial:
        of = _buscar_codigo_oficial(nombre_producto, buscar_oficial)
        if of and (of.get('marca') or '').strip():
            return of['marca'].strip(), True
    return '', False


def _build_vtas_pvp(rows, anio, mes, catalogo_cliente=None, buscar_oficial=None):
    """Filas del anexo PVP: una por producto (codProdPVP), con precio ex-fábrica
    y PVP promedio por botella, vigentes desde el inicio del período."""
    ag = OrderedDict()
    no_reconocidos = set()
    cache = {}
    for r in rows:
        nombre = r.get("nombre_producto") or ""
        cajas = int(_f(r.get("cantidad_cajas")))
        # Los PACKS se dividen también en el PVP: precio prorrateado por componente.
        if es_pack(nombre):
            comps = descomponer_pack(nombre)
            num = len(comps) or 1
            grado = _extraer_grado(nombre) or "15"
            sin_imp_c = _f(r.get("precio_total_sin_impuesto")) / num
            total_c = _f(r.get("importe_total")) / num
            items = [(f"{cn} {grado}V {cc}ML", cajas, sin_imp_c, total_c) for cn, cc in comps]
        else:
            items = [(nombre, int(_f(r.get("unidades_botellas"))),
                      _f(r.get("precio_total_sin_impuesto")), _f(r.get("importe_total")))]
        for comp_nombre, bottles, sin_imp, total in items:
            if comp_nombre in cache:
                cod, ok = cache[comp_nombre]
            else:
                cod, ok = _resolver_cod_prod_pvp(comp_nombre, catalogo_cliente, buscar_oficial)
                cache[comp_nombre] = (cod, ok)
            if not ok:
                no_reconocidos.add(comp_nombre[:80])
            a = ag.get(cod or comp_nombre)
            if not a:
                a = ag[cod or comp_nombre] = {"cod": cod, "nombre": comp_nombre, "botellas": 0,
                                              "sin_imp": 0.0, "total": 0.0}
            a["botellas"] += bottles
            a["sin_imp"] += sin_imp
            a["total"] += total
    fecha_ini = f"01/{str(mes).zfill(2)}/{anio}"
    vtas = []
    for a in ag.values():
        b = a["botellas"] or 1
        vtas.append({
            "codProdPVP": a["cod"],
            "gramoAzucar": "0.00",
            "precioExPVP": f"{a['sin_imp'] / b:.2f}",
            "precioPVP": f"{a['total'] / b:.2f}",
            "fechaInPVP": fecha_ini,
            "fechaFinPVP": "",
            "nombreProducto": a["nombre"],
        })
    advertencias = []
    if no_reconocidos:
        advertencias.append(
            "Productos sin código PVP (corrígelos en el editor o el catálogo): "
            + "; ".join(sorted(p for p in no_reconocidos if p))
        )
    return vtas, advertencias


def anexo_rows(rows, contribuyente, anio, mes, act_import="02", catalogo_cliente=None, buscar_oficial=None, tipo="ICE"):
    """Filas del anexo (ICE o PVP) listas para editar en el editor."""
    c = contribuyente or {}
    base_header = {
        "TipoIDInformante": "R",
        "IdInformante": c.get("identificacion", ""),
        "razonSocial": _sin_tildes(c.get("nombre", "")),
        "Anio": str(anio),
        "Mes": str(mes).zfill(2),
    }
    if str(tipo).upper() == "PVP":
        vtas, advertencias = _build_vtas_pvp(rows, anio, mes, catalogo_cliente, buscar_oficial)
        header = {**base_header, "tipoCarga": "", "codigoOperativo": "PVP"}
        return {"tipo": "PVP", "header": header, "rows": vtas, "advertencias": advertencias}
    vtas, advertencias = _build_vtas(rows, catalogo_cliente, buscar_oficial)
    for v in vtas:
        v["ventaICE"] = str(v["ventaICE"])
    header = {**base_header, "actImport": str(act_import)[:2], "codigoOperativo": "ICE"}
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


def generar_anexo_ice(rows, contribuyente, anio, mes, act_import="02", catalogo_cliente=None, buscar_oficial=None):
    """Genera el XML del anexo ICE. Agrupa ventas por idCliente + codProdICE.
    Devuelve {xml, ventas, advertencias}."""
    vtas, no_reconocidos_adv = _build_vtas(rows, catalogo_cliente, buscar_oficial)
    dedup = {(v["idCliente"], v["codProdICE"]): v for v in vtas}

    mes_str = str(mes).zfill(2)
    ruc = (contribuyente or {}).get("identificacion", "")
    razon = _sin_tildes((contribuyente or {}).get("nombre", ""))

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
