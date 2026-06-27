"""Tarifas ICE por categoría y año, IVA por fecha, y cálculo manual de ICE.

Categorías:
  - ALCOHOLICA  → bebidas alcohólicas (ICE específico + ad-valorem si supera umbral)
  - ARTESANAL   → cervezas artesanales (solo ICE específico)
  - INDUSTRIAL  → cervezas industriales (solo ICE específico)

IVA: 12% en 2021-2023; en 2024 12% hasta marzo y 15% desde abril; 15% desde 2025.
Nota: la tarifa industrial 2021 tenía rangos por volumen de producción; se usa el
Rango 1 (8.41) como referencia.
"""

# tarifa específica por litro de alcohol puro, por categoría y año; umbral ad-valorem
TARIFAS = {
    "2021": {"ALCOHOLICA": 7.18, "ARTESANAL": 1.49, "INDUSTRIAL": 8.41, "umbral": 4.29},
    "2022": {"ALCOHOLICA": 10.00, "ARTESANAL": 1.50, "INDUSTRIAL": 13.08, "umbral": 4.37},
    "2023": {"ALCOHOLICA": 10.00, "ARTESANAL": 1.50, "INDUSTRIAL": 13.08, "umbral": 4.53},
    "2024": {"ALCOHOLICA": 10.15, "ARTESANAL": 1.52, "INDUSTRIAL": 13.28, "umbral": 4.60},
    "2025": {"ALCOHOLICA": 10.30, "ARTESANAL": 1.54, "INDUSTRIAL": 13.48, "umbral": 4.67},
    "2026": {"ALCOHOLICA": 10.41, "ARTESANAL": 1.56, "INDUSTRIAL": 13.62, "umbral": 4.72},
}

# 2021 — cerveza industrial: tarifa específica por escala de producción del
# productor (Res. NAC-DGERCGC20-00000078). Desde 2022 hay tarifa única (13.08…).
#   R1 pequeña escala (≤730.000 hl) · R2 mediana (≤1.400.000 hl) · R3 gran (>1.4M hl)
RANGOS_IND_2021 = {"R1": 8.41, "R2": 10.48, "R3": 13.08}

PORC_ADVALOREM = 0.75
# Categorías que pagan ICE ad-valorem (75% sobre el excedente del umbral): bebidas
# alcohólicas y cerveza industrial. La cerveza artesanal solo paga ICE específico.
CAT_CON_ADVALOREM = {"ALCOHOLICA", "INDUSTRIAL"}
CATEGORIAS = ["ALCOHOLICA", "ARTESANAL", "INDUSTRIAL"]
CAT_LABEL = {
    "ALCOHOLICA": "Bebidas alcohólicas",
    "ARTESANAL": "Cervezas artesanales",
    "INDUSTRIAL": "Cervezas industriales",
}


def _f(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def tarifas_anio(anio):
    return TARIFAS.get(str(anio), TARIFAS["2026"])


def iva_rate(anio, mes):
    """IVA según la fecha: 12% hasta 2023; 2024 = 12% ene-mar / 15% abr-dic; 15% desde 2025."""
    try:
        a = int(anio)
        m = int(mes or 1)
    except (TypeError, ValueError):
        return 0.15
    if a <= 2023:
        return 0.12
    if a == 2024:
        return 0.12 if m <= 3 else 0.15
    return 0.15


def calcular_fila(row, anio, mes):
    """Calcula ICE específico, ad-valorem, IVA y PVP de una fila."""
    tar = tarifas_anio(anio)
    cat = (row.get("categoria") or "ALCOHOLICA").upper()
    if cat not in CATEGORIAS:
        cat = "ALCOHOLICA"
    tarifa = tar.get(cat, 0.0)
    # 2021 cerveza industrial: tarifa por escala de producción (rango elegido)
    if cat == "INDUSTRIAL" and str(anio) == "2021" and row.get("rango_ind"):
        tarifa = RANGOS_IND_2021.get(row.get("rango_ind"), tarifa)
    umbral = tar.get("umbral", 0.0)
    iva_tasa = iva_rate(anio, mes)

    por_cajas = bool(row.get("por_cajas", True))
    cajas = _f(row.get("cajas"))
    bpc = _f(row.get("botellas_por_caja")) or 0
    unidades = _f(row.get("unidades"))
    grado = _f(row.get("grado"))
    cap = _f(row.get("capacidad"))
    precio = _f(row.get("precio"))

    total_bot = cajas * bpc if por_cajas else unidades
    precio_bot = (precio / bpc if bpc > 0 else 0) if por_cajas else precio
    litros_pb = (grado / 100.0) * (cap / 1000.0)
    precio_litro = (precio_bot * 1000.0) / cap if cap > 0 else 0

    ice_esp = tarifa * litros_pb * total_bot
    ice_adv = 0.0
    aplica_adv = cat in CAT_CON_ADVALOREM and precio_litro > umbral
    if aplica_adv:
        ice_adv = (precio_litro - umbral) * PORC_ADVALOREM * (cap / 1000.0) * total_bot
    total_ice = ice_esp + ice_adv
    subtotal = precio_bot * total_bot
    base_iva = subtotal + total_ice
    iva = base_iva * iva_tasa
    pvp = base_iva + iva

    return {
        "categoria": cat,
        "total_botellas": round(total_bot, 2),
        "precio_botella": round(precio_bot, 4),
        "precio_litro": round(precio_litro, 4),
        "aplica_adv": aplica_adv,
        "ice_especifico": round(ice_esp, 4),
        "ice_advalorem": round(ice_adv, 4),
        "total_ice": round(total_ice, 4),
        "subtotal": round(subtotal, 2),
        "base_iva": round(base_iva, 2),
        "iva": round(iva, 2),
        "pvp": round(pvp, 2),
        # por caja
        "ice_por_caja": round(total_ice / cajas, 4) if (por_cajas and cajas > 0) else round(total_ice, 4),
        "iva_tasa": iva_tasa,
    }
