"""Datos tributarios, catálogo de productos y cálculos de ICE.
Portado de ICEcompleto(1).py (lógica, sin la interfaz tkinter)."""

from services.ice_calc_data import TARIFAS, PORC_ADVALOREM, iva_rate as _iva_rate

# Base tributaria por año: esp = tarifa específica, umb = umbral ad-valorem, iva.
# Se deriva de services.ice_calc_data.TARIFAS (fuente única) para bebidas
# alcohólicas — antes había una segunda tabla hardcodeada aquí que podía
# desincronizarse si se actualizaba una tarifa anual y se olvidaba la otra.
TAX_DB = {
    anio: {"esp": tar["ALCOHOLICA"], "umb": tar["umbral"], "iva": _iva_rate(int(anio), 12)}
    for anio, tar in TARIFAS.items()
}

CATALOGO_BASE = {
    'LICOR ORO': {'codMarca': '019167', 'codProdSRI': '19167', 'presentacion': '13', 'capacidad': '750', 'unidad': '66', 'grado': '15', 'codImpuesto': '3031', 'tipo': 'Licor', 'botellas_por_caja': 12},
    'LICOR SECO BLANCO': {'codMarca': '039919', 'codProdSRI': '39919', 'presentacion': '13', 'capacidad': '750', 'unidad': '66', 'grado': '15', 'codImpuesto': '3031', 'tipo': 'Licor', 'botellas_por_caja': 12},
    'AGUARDIENTE DE CAÑA': {'codMarca': '036886', 'codProdSRI': '36886', 'presentacion': '13', 'capacidad': '750', 'unidad': '66', 'grado': '15', 'codImpuesto': '3031', 'tipo': 'Licor', 'botellas_por_caja': 12},
    'VODKA SECO GLACIAL': {'codMarca': '027298', 'codProdSRI': '27298', 'presentacion': '13', 'capacidad': '750', 'unidad': '66', 'grado': '15', 'codImpuesto': '3031', 'tipo': 'Licor', 'botellas_por_caja': 12},
    'COCKTAIL CON VODKA SABOR A MARACUYA': {'codMarca': '022744', 'codProdSRI': '22744', 'presentacion': '13', 'capacidad': '800', 'unidad': '66', 'grado': '5', 'codImpuesto': '3031', 'tipo': 'Cocktail', 'botellas_por_caja': 12},
    'COCKTAIL CON BAJO GRADO ALCOHOLICO SABOR A DURAZNO': {'codMarca': '006868', 'codProdSRI': '6868', 'presentacion': '13', 'capacidad': '800', 'unidad': '66', 'grado': '5', 'codImpuesto': '3031', 'tipo': 'Cocktail', 'botellas_por_caja': 12},
    'COCKTAIL CON VODKA SABOR A GUARANA': {'codMarca': '039912', 'codProdSRI': '39912', 'presentacion': '13', 'capacidad': '750', 'unidad': '66', 'grado': '5', 'codImpuesto': '3031', 'tipo': 'Cocktail', 'botellas_por_caja': 12},
}

PALABRAS_CLAVE = {
    'LICOR ORO': ['LICOR ORO'],
    'LICOR SECO BLANCO': ['LICOR SECO BLANCO'],
    'AGUARDIENTE DE CAÑA': ['AGUARDIENTE DE CAÑA', 'AGUARDIENTE'],
    'VODKA SECO GLACIAL': ['VODKA SECO GLACIAL', 'VODKA SECO'],
    'COCKTAIL CON VODKA SABOR A MARACUYA': ['MARACUYA', 'MARACUYÁ'],
    'COCKTAIL CON BAJO GRADO ALCOHOLICO SABOR A DURAZNO': ['DURAZNO'],
    'COCKTAIL CON VODKA SABOR A GUARANA': ['GUARANA', 'GUARANÁ'],
}

DEFAULT_CAT = {
    'codMarca': '000000', 'presentacion': '13', 'capacidad': '750',
    'unidad': '66', 'grado': '15', 'codImpuesto': '3031',
    'tipo': 'Licor', 'botellas_por_caja': 12,
}


def buscar_en_catalogo(descripcion: str) -> dict:
    desc = (descripcion or '').upper()
    for nombre, claves in PALABRAS_CLAVE.items():
        for clave in claves:
            if clave in desc and nombre in CATALOGO_BASE:
                return dict(CATALOGO_BASE[nombre])
    return dict(DEFAULT_CAT)


def es_pack(descripcion: str) -> bool:
    desc = (descripcion or '').upper()
    if 'PACK' in desc:
        return True
    if '+' in (descripcion or '') and any(p in desc for p in ['AGUARDIENTE', 'VODKA', 'LICOR']):
        return True
    return False


import re as _re


def _nombre_componente(parte: str) -> str:
    """Nombre de un componente de pack, mapeado al catálogo cuando se reconoce."""
    if 'VODKA SECO GLACIAL' in parte or 'VODKA SECO' in parte or 'VODKA' in parte:
        return 'VODKA SECO GLACIAL'
    if 'LICOR ORO' in parte:
        return 'LICOR ORO'
    if 'LICOR SECO BLANCO' in parte:
        return 'LICOR SECO BLANCO'
    if 'AGUARDIENTE' in parte:
        return 'AGUARDIENTE DE CAÑA'
    s = _re.sub(r'\([^)]*\)', ' ', parte)
    s = _re.sub(r'\d+(?:[.,]\d+)?\s*(?:ML|CC|LTS?|L|V|°|G\.?L\.?|GRADOS?|U)\b', ' ', s)
    s = _re.sub(r'\b\d+(?:[.,]\d+)?\b', ' ', s)
    return _re.sub(r'\s+', ' ', s).strip() or 'LICOR'


def descomponer_pack(descripcion: str):
    """Descompone un pack en sus botellas individuales, RESPETANDO la cantidad (NU)
    de cada componente (ej. 'PACK X (2U) + Y (1U)' = [X, X, Y]). Una entrada por botella,
    así ninguna botella del pack queda sin contabilizar para el ICE."""
    desc = (descripcion or '').upper()
    cuerpo = _re.sub(r'^\s*(?:DUO|TRIO|MULTI|MEGA)?\s*PACK\s*', '', desc)
    productos = []
    for parte in _re.split(r'\s*\+\s*', cuerpo):
        parte = parte.strip()
        if not parte:
            continue
        mq = _re.search(r'\((\d+)\s*U\)', parte)
        qty = int(mq.group(1)) if mq else 1
        mc = _re.search(r'(\d+(?:[.,]\d+)?)\s*ML', parte)
        cap = str(int(float(mc.group(1).replace(',', '.')))) if mc else '750'
        nombre = _nombre_componente(parte)
        for _ in range(max(1, qty)):
            productos.append((nombre, cap))
    if not productos:
        productos.append(('LICOR ORO', '750'))
    return productos


def get_botellas_por_caja(descripcion: str) -> int:
    """Botellas por unidad de venta a partir de '(NU)' en la descripción:
    '(1U)' = 1 botella (venta unitaria), '(12U)' = 12, '(24U)' = 24. Por defecto 12.
    Evita inflar/desinflar el conteo de botellas (y por ende el ICE)."""
    desc = (descripcion or '').upper()
    if es_pack(descripcion):
        return 2
    m = _re.search(r'\((\d+)\s*U\)', desc)
    if m:
        return max(1, int(m.group(1)))
    return 12


def calcular_ice_especifico(tarifa_esp: float, grado: float, volumen_cc: float) -> float:
    """ICE específico por botella: tarifa * (grado/100) * (volumen/1000 litros)."""
    return tarifa_esp * (grado / 100.0) * (volumen_cc / 1000.0)


def calcular_ice_advalorem(precio_por_botella: float, volumen_cc: float, umbral: float) -> float:
    """ICE ad-valorem por botella: si el precio por litro supera el umbral,
    (precio_litro - umbral) * 0.75 * (volumen/1000)."""
    precio_litro = (precio_por_botella * 1000.0) / volumen_cc if volumen_cc > 0 else 0
    if precio_litro > umbral:
        return (precio_litro - umbral) * PORC_ADVALOREM * (volumen_cc / 1000.0)
    return 0.0


def tax_params(anio: str) -> dict:
    return TAX_DB.get(str(anio), TAX_DB["2026"])
