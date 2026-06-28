"""Cálculo de auditoría ICE (específico + ad-valorem) por año fiscal.
Replica la hoja 'Auditoría por Producto' de ICEcompleto(1).py: el ICE se
calcula por botella y se multiplica por el total de botellas (bot/caja * cajas)."""
from typing import List, Dict
from collections import defaultdict
from services.ice_data import (
    descomponer_pack, buscar_en_catalogo,
    calcular_ice_especifico, calcular_ice_advalorem, tax_params,
)


def _f(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


import re
import unicodedata

# Palabras sin valor para identificar el producto (envase, unidades, conectores).
_RUIDO = {"CAJA", "PACK", "BOTELLA", "BOTELLAS", "UNIDAD", "UNIDADES", "ML", "CC",
          "LT", "DE", "DEL", "LA", "EL", "LOS", "LAS", "CON", "Y", "A", "SABOR",
          "CORP", "BAJO", "GRADO", "ALCOHOLICO", "ALCOHOLICA", "CONTENIDO", "BEBIDA"}


def _norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().upper()
    return s


def _tokens(nombre):
    """Palabras significativas (≥3 letras) que identifican al producto."""
    return {t for t in re.findall(r"[A-Z]{3,}", _norm(nombre)) if t not in _RUIDO}


def _indexar_catalogo(catalogo):
    """Índices del catálogo del cliente: por código (SRI/ICE/PVP) y por tokens de nombre."""
    por_cod, por_nombre = {}, []
    for p in (catalogo or []):
        for ck in ("cod_prod_sri", "cod_prod_pvp", "cod_prod_ice"):
            c = str(p.get(ck) or "").strip()
            if c:
                por_cod.setdefault(c, p)
        toks = _tokens(p.get("nombre"))
        if toks:
            cap = _f(p.get("capacidad"))
            por_nombre.append((toks, cap, p))
    return por_cod, por_nombre


def _match_cat(nombre, codigo, idx, vol_hint=None):
    """Empareja la descripción de la factura con un producto del catálogo del cliente:
    por código exacto, o por mayor coincidencia de palabras (con desempate por capacidad).
    Devuelve el producto o None."""
    por_cod, por_nombre = idx
    c = str(codigo or "").strip()
    if c and c in por_cod:
        return por_cod[c]
    stoks = _tokens(nombre)
    if not stoks:
        return None
    best, best_score = None, 0.0
    for ctoks, cap, p in por_nombre:
        comunes = len(ctoks & stoks)
        if comunes == 0:
            continue
        score = comunes
        if vol_hint and cap and abs(cap - _f(vol_hint)) < 1:
            score += 0.5  # desempate por capacidad
        if score > best_score:
            best_score, best = score, p
    return best if best_score >= 2 else None


def audit_detail(rows: List[Dict], anio: str, catalogo: List[Dict] = None) -> List[Dict]:
    """Una fila de auditoría por producto individual (descompone packs). El grado
    alcohólico y la capacidad (ml) se toman del CATÁLOGO DEL CLIENTE cuando existe
    (por código o nombre); si no, de la factura (XML); en último caso, valores por defecto."""
    tax = tax_params(anio)
    esp, umb, iva_tasa = tax["esp"], tax["umb"], tax["iva"]
    idx = _indexar_catalogo(catalogo)
    out = []
    n = 0
    for r in rows:
        if r.get("estado") == "DUPLICADO":
            continue
        cajas = _f(r.get("cantidad_cajas"))
        if r.get("es_pack"):
            productos = descomponer_pack(r.get("nombre_producto", ""))
            num = len(productos)
            precio_bot = _f(r.get("precio_total_sin_impuesto")) / (num * cajas) if cajas > 0 else 0
            for prod_nombre, prod_cap in productos:
                p = _match_cat(prod_nombre, None, idx, vol_hint=prod_cap)
                if p:
                    grado = _f(p.get("grado"), 15)
                    vol = _f(p.get("capacidad"), _f(prod_cap, 750))
                else:
                    cat = buscar_en_catalogo(prod_nombre)
                    grado = _f(cat.get("grado", 15))
                    vol = _f(prod_cap)
                bottles = cajas  # G=1 (bot/caja) * H=cajas
                out.append(_audit_row(n + 1, r, f"{prod_nombre} {round(vol)}ml", True,
                                      grado, vol, bottles, precio_bot, esp, umb, iva_tasa))
                n += 1
        else:
            p = _match_cat(r.get("nombre_producto", ""), r.get("codigo_producto", ""), idx, vol_hint=r.get("capacidad"))
            if p:  # catálogo del cliente manda sobre el XML
                grado = _f(p.get("grado"), _f(r.get("grado_alcoholico"), 15))
                vol = _f(p.get("capacidad"), _f(r.get("capacidad"), 750))
                bxc = _f(p.get("botellas_por_caja"), _f(r.get("botellas_por_caja"), 12))
            else:
                grado = _f(r.get("grado_alcoholico", 15))
                vol = _f(r.get("capacidad", 750))
                bxc = _f(r.get("botellas_por_caja", 12))
            bottles = _f(r.get("unidades_botellas")) or (cajas * bxc)
            precio_bot = _f(r.get("precio_por_botella"))
            out.append(_audit_row(n + 1, r, r.get("nombre_producto", ""), False,
                                  grado, vol, bottles, precio_bot, esp, umb, iva_tasa))
            n += 1
    return out


def _audit_row(idx, r, prod_individual, pack, grado, vol, bottles, precio_bot, esp, umb, iva_tasa):
    precio_litro = (precio_bot * 1000.0) / vol if vol > 0 else 0
    ice_esp = calcular_ice_especifico(esp, grado, vol) * bottles
    ice_adv = calcular_ice_advalorem(precio_bot, vol, umb) * bottles
    total_ice = ice_esp + ice_adv
    subtotal = precio_bot * bottles
    base_iva = subtotal + total_ice
    iva = base_iva * iva_tasa
    pvp = base_iva + iva
    return {
        "n": idx, "fecha": r.get("fecha", ""), "cliente": r.get("razon_social_cliente", ""),
        "producto_original": r.get("nombre_producto", ""), "es_pack": pack,
        "producto_individual": prod_individual,
        "grado": round(grado, 2), "volumen": round(vol, 2),
        "botellas": round(bottles, 2), "precio_botella": round(precio_bot, 4),
        "precio_litro": round(precio_litro, 4),
        "aplica_adv": precio_litro > umb,
        "ice_especifico": round(ice_esp, 4), "ice_advalorem": round(ice_adv, 4),
        "total_ice": round(total_ice, 4),
        "subtotal": round(subtotal, 2),
        "base_iva": round(base_iva, 2), "iva": round(iva, 2), "pvp": round(pvp, 2),
    }


def resumen_por_producto(rows: List[Dict], anio: str, catalogo: List[Dict] = None) -> List[Dict]:
    det = audit_detail(rows, anio, catalogo)
    ag = defaultdict(lambda: {"botellas": 0.0, "subtotal": 0.0, "ice_especifico": 0.0,
                              "ice_advalorem": 0.0, "total_ice": 0.0, "base_iva": 0.0,
                              "iva": 0.0, "pvp": 0.0, "aplica_adv": False})
    for d in det:
        key = d["producto_individual"]
        a = ag[key]
        a["botellas"] += d["botellas"]
        a["subtotal"] += d["subtotal"]
        a["ice_especifico"] += d["ice_especifico"]
        a["ice_advalorem"] += d["ice_advalorem"]
        a["total_ice"] += d["total_ice"]
        a["base_iva"] += d["base_iva"]
        a["iva"] += d["iva"]
        a["pvp"] += d["pvp"]
        a["aplica_adv"] = a["aplica_adv"] or d["aplica_adv"]
    filas = []
    for nombre, v in sorted(ag.items()):
        filas.append({"producto": nombre, **{k: round(val, 2) if isinstance(val, float) else val for k, val in v.items()}})
    return filas


def resumen_general(rows: List[Dict], anio: str, catalogo: List[Dict] = None) -> Dict:
    det = audit_detail(rows, anio, catalogo)
    tot = {"subtotal": 0.0, "ice_especifico": 0.0, "ice_advalorem": 0.0,
           "total_ice": 0.0, "base_iva": 0.0, "iva": 0.0, "pvp": 0.0, "lineas": 0}
    for d in det:
        tot["subtotal"] += d["subtotal"]
        tot["ice_especifico"] += d["ice_especifico"]
        tot["ice_advalorem"] += d["ice_advalorem"]
        tot["total_ice"] += d["total_ice"]
        tot["base_iva"] += d["base_iva"]
        tot["iva"] += d["iva"]
        tot["pvp"] += d["pvp"]
        tot["lineas"] += 1
    for k in list(tot.keys()):
        if k != "lineas":
            tot[k] = round(tot[k], 2)
    return tot


def full_report(rows: List[Dict], anio: str, catalogo: List[Dict] = None) -> Dict:
    tax = tax_params(anio)
    return {
        "anio": str(anio),
        "params": {"esp": tax["esp"], "umbral": tax["umb"], "iva": tax["iva"], "advalorem": 0.75},
        "por_producto": resumen_por_producto(rows, anio, catalogo),
        "general": resumen_general(rows, anio, catalogo),
        "detalle": audit_detail(rows, anio, catalogo),
    }
