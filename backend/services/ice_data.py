"""Datos tributarios, catálogo de productos y cálculos de ICE.
Portado de ICEcompleto(1).py (lógica, sin la interfaz tkinter)."""

# Base tributaria por año: esp = tarifa específica, umb = umbral ad-valorem, iva.
TAX_DB = {
    "2021": {"esp": 7.18, "umb": 4.29, "iva": 0.12},
    "2022": {"esp": 10.00, "umb": 4.37, "iva": 0.12},
    "2023": {"esp": 10.00, "umb": 4.53, "iva": 0.12},
    "2024": {"esp": 10.15, "umb": 4.60, "iva": 0.15},
    "2025": {"esp": 10.30, "umb": 4.67, "iva": 0.15},
    "2026": {"esp": 10.41, "umb": 4.72, "iva": 0.15},
}

PORC_ADVALOREM = 0.75

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


def descomponer_pack(descripcion: str):
    desc = (descripcion or '').upper()
    productos = []
    if 'VODKA SECO GLACIAL' in desc or 'VODKA SECO' in desc:
        productos.append(('VODKA SECO GLACIAL', '750'))
    elif 'VODKA' in desc:
        productos.append(('VODKA SECO GLACIAL', '750'))
    if 'LICOR ORO' in desc:
        productos.append(('LICOR ORO', '750'))
    if 'AGUARDIENTE DE CAÑA' in desc or 'AGUARDIENTE' in desc:
        productos.append(('AGUARDIENTE DE CAÑA', '375' if '375' in (descripcion or '') else '750'))
    if not productos:
        productos.append(('LICOR ORO', '750'))
    return productos


def get_botellas_por_caja(descripcion: str) -> int:
    desc = (descripcion or '').upper()
    if es_pack(descripcion):
        return 2
    if '12U' in desc or '(12U)' in desc:
        return 12
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
