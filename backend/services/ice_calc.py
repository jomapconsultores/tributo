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


def audit_detail(rows: List[Dict], anio: str) -> List[Dict]:
    """Una fila de auditoría por producto individual (descompone packs)."""
    tax = tax_params(anio)
    esp, umb, iva_tasa = tax["esp"], tax["umb"], tax["iva"]
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
                cat = buscar_en_catalogo(prod_nombre)
                grado = _f(cat.get("grado", 15))
                vol = _f(prod_cap)
                bottles = cajas  # G=1 (bot/caja) * H=cajas
                out.append(_audit_row(n + 1, r, f"{prod_nombre} {prod_cap}ml", True,
                                      grado, vol, bottles, precio_bot, esp, umb, iva_tasa))
                n += 1
        else:
            grado = _f(r.get("grado_alcoholico", 15))
            vol = _f(r.get("capacidad", 750))
            bottles = _f(r.get("unidades_botellas")) or (cajas * _f(r.get("botellas_por_caja", 12)))
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


def resumen_por_producto(rows: List[Dict], anio: str) -> List[Dict]:
    det = audit_detail(rows, anio)
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


def resumen_general(rows: List[Dict], anio: str) -> Dict:
    det = audit_detail(rows, anio)
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


def full_report(rows: List[Dict], anio: str) -> Dict:
    tax = tax_params(anio)
    return {
        "anio": str(anio),
        "params": {"esp": tax["esp"], "umbral": tax["umb"], "iva": tax["iva"], "advalorem": 0.75},
        "por_producto": resumen_por_producto(rows, anio),
        "general": resumen_general(rows, anio),
    }
