from collections import defaultdict
from services.ice_calc_data import calcular_fila, CATEGORIAS, CAT_LABEL


def enrich(rows, anio, mes):
    out = []
    for r in rows:
        c = calcular_fila(r, anio, mes)
        out.append({**r, **c})
    return out


def _acc():
    return {"num": 0, "botellas": 0.0, "subtotal": 0.0, "ice_especifico": 0.0,
            "ice_advalorem": 0.0, "total_ice": 0.0, "base_iva": 0.0, "iva": 0.0, "pvp": 0.0}


def _add(a, d):
    a["num"] += 1
    a["botellas"] += d["total_botellas"]
    a["subtotal"] += d["subtotal"]
    a["ice_especifico"] += d["ice_especifico"]
    a["ice_advalorem"] += d["ice_advalorem"]
    a["total_ice"] += d["total_ice"]
    a["base_iva"] += d["base_iva"]
    a["iva"] += d["iva"]
    a["pvp"] += d["pvp"]


def _round(a):
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in a.items()}


def por_categoria(filas):
    ag = {c: _acc() for c in CATEGORIAS}
    for d in filas:
        _add(ag[d["categoria"]], d)
    return [{"categoria": c, "label": CAT_LABEL[c], **_round(ag[c])} for c in CATEGORIAS if ag[c]["num"] > 0]


def por_producto(filas):
    ag = defaultdict(_acc)
    for d in filas:
        key = ((d.get("producto") or "(sin nombre)").upper(), d["categoria"])
        _add(ag[key], d)
    out = []
    for (prod, cat), a in sorted(ag.items()):
        out.append({"producto": prod, "categoria": cat, "label": CAT_LABEL[cat], **_round(a)})
    return out


def general(filas):
    tot = _acc()
    for d in filas:
        _add(tot, d)
    return _round(tot)


def full_report(rows, anio, mes):
    filas = enrich(rows, anio, mes)
    return {
        "anio": str(anio), "mes": mes,
        "por_categoria": por_categoria(filas),
        "por_producto": por_producto(filas),
        "general": general(filas),
    }
