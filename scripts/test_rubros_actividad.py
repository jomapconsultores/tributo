# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""El tipo de gasto que se propone para cada comprobante de la devolución.

POR QUÉ EXISTE: ese dato se DECLARA al SRI. Una propuesta equivocada que nadie
revisa termina en una solicitud mal presentada, y el portal no siempre se queja.

Hay dos fuentes de pista y las dos se prueban acá:

  · La ACTIVIDAD ECONÓMICA del catastro del SRI, que es la buena: dice el giro
    con todas las letras. Su vocabulario es el del catastro ("ENSEÑANZA",
    "PRENDAS DE VESTIR"), no el de los nombres comerciales, y por eso las pistas
    se escribieron dos veces mal antes de esta prueba.
  · El NOMBRE del proveedor, que es lo único que trae la grilla del portal
    cuando el proveedor nunca pasó por Gastos. Es una adivinanza y tiene que
    seguir siendo conservadora: ante la duda, vacío, que el usuario elige.

    cd backend && ./venv/Scripts/python.exe ../scripts/test_rubros_actividad.py
"""
import io
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from routers.devoluciones_iva import (                    # noqa: E402
    _rubro_sugerido, _resolver_actividad, _claves_por_largo, _nombre_clave)

# Actividades tal como las escribe el catastro del SRI (con sus tildes y su Ñ).
ACTIVIDADES = [
    ("VENTA AL POR MENOR DE GRAN VARIEDAD DE PRODUCTOS EN TIENDAS, ENTRE LOS QUE "
     "PREDOMINAN LOS PRODUCTOS ALIMENTICIOS.", "alimentacion"),
    ("ACTIVIDADES DE ALQUILER DE BIENES INMUEBLES A CAMBIO DE UNA RETRIBUCIÓN O POR "
     "CONTRATO (VIVIENDA).", "vivienda"),
    ("VENTA AL POR MENOR DE PRODUCTOS FARMACÉUTICOS Y MEDICINALES.", "salud"),
    ("VENTA AL POR MENOR DE PRENDAS DE VESTIR EN ESTABLECIMIENTOS ESPECIALIZADOS.",
     "vestimenta"),
    ("ENSEÑANZA PREPRIMARIA Y PRIMARIA.", "educacion"),
    ("ENSEÑANZA SUPERIOR.", "educacion"),
    ("ACTIVIDADES DE RESTAURANTES Y DE SERVICIO MOVIL DE COMIDAS.", "alimentacion"),
    ("ACTIVIDADES DE MÉDICOS GENERALES.", "salud"),
    ("VENTA AL POR MENOR DE CALZADO.", "vestimenta"),
    ("SUMINISTRO DE ENERGÍA ELÉCTRICA.", "vivienda"),
    # Lo que no califica no se fuerza a ningún cajón.
    ("TRANSPORTE DE CARGA POR CARRETERA.", ""),
    ("", ""),
]

# Nombres como llegan en la grilla del portal: razón social, sin el giro.
NOMBRES = [
    ("GERARDO ORTIZ E HIJOS CIA LTDA CORAL", "alimentacion"),
    ("ORTEGA BERMEO NANCY CUMANDA PIZZA HOUSE", "alimentacion"),
    ("CORPORACION FAVORITA C.A.", "alimentacion"),
    ("FARMACIAS Y COMISARIATOS DE MEDICINAS S.A.", "salud"),
    ("EMPRESA PUBLICA MUNICIPAL DE AGUA POTABLE", "vivienda"),
    ("ALIMENTOS DEL GOLFO S.A.S.", "alimentacion"),
    # Personas: una sigla suelta adentro de un nombre no puede decidir un rubro.
    ("PACHECO VIDAL CARLOS GILBERTO", ""),
    ("VALLEJO QUINTEROS FABIAN BRIAN", ""),
    ("CRISTIAN SEBASTIAN MORALES", ""),
]


# Cómo escribe el portal al proveedor (razón social + nombre comercial pegados)
# contra cómo está en el sistema (razón social sola). Sin casar por prefijo, de
# 17 proveedores de una solicitud real casaba UNO: el único cuyo nombre comercial
# repetía la razón social.
CONOCIDOS = [
    ("GERARDO ORTIZ E HIJOS CIA LTDA",
     "VENTA AL POR MENOR DE GRAN VARIEDAD DE PRODUCTOS EN SUPERMERCADOS, ENTRE LOS "
     "QUE PREDOMINAN, LOS PRODUCTOS ALIMENTICIOS."),
    ("COMERCIAL ETATEX C.A.",
     "VENTA AL POR MENOR DE ACCESORIOS DE VESTIR EN ESTABLECIMIENTOS ESPECIALIZADOS."),
    ("PEREZ AREVALO LINDA LUCIA",
     "VENTA AL POR MENOR DE PRENDAS DE VESTIR Y PELETERÍA EN ESTABLECIMIENTOS "
     "ESPECIALIZADOS."),
    ("DELI INTERNACIONAL S.A.",
     "VENTA DE COMIDAS Y BEBIDAS EN BARES- RESTAURANTES, INCLUSO PARA LLEVAR."),
    # Un prefijo genérico no puede ganarle a nadie.
    ("COMERCIAL", "ACTIVIDAD GENÉRICA QUE NO DEBE ARRASTRAR A OTROS PROVEEDORES"),
]

DEL_PORTAL = [
    ("GERARDO ORTIZ E HIJOS CIA LTDA CORAL CARLOS JULIO", "alimentacion"),
    ("COMERCIAL ETATEX C.A. ETAFASHION", "vestimenta"),
    ("PEREZ AREVALO LINDA LUCIA INGESA", "vestimenta"),
    ("DELI INTERNACIONAL S.A. DELI INTERNACIONAL S.A", "alimentacion"),
    # Nadie conocido detrás: sin actividad y sin rubro.
    ("PACHECO VIDAL CARLOS GILBERTO", ""),
]


def correr_cruce():
    print("— cruce del nombre del portal con el proveedor conocido")
    mapa = {_nombre_clave(n): {"actividad": a, "ruc": "9" * 13} for n, a in CONOCIDOS}
    claves = _claves_por_largo(mapa)
    malos = 0
    for nombre, esperado in DEL_PORTAL:
        act = _resolver_actividad(mapa, claves, nombre).get("actividad", "")
        obtenido = _rubro_sugerido(act) if act else ""
        bien = obtenido == esperado
        malos += not bien
        if not bien:
            print(f"  ✖ {nombre[:60]!r}")
            print(f"     esperaba {esperado!r} y dio {obtenido!r} (actividad: {act[:50]!r})")
    print(f"  {'✔' if not malos else '✖'} {len(DEL_PORTAL) - malos}/{len(DEL_PORTAL)}")
    return malos


def correr(titulo, casos):
    print(f"— {titulo}")
    malos = 0
    for texto, esperado in casos:
        obtenido = _rubro_sugerido(texto)
        bien = obtenido == esperado
        malos += not bien
        if not bien:
            print(f"  ✖ {texto[:60]!r}")
            print(f"     esperaba {esperado!r} y dio {obtenido!r}")
    print(f"  {'✔' if not malos else '✖'} {len(casos) - malos}/{len(casos)}")
    return malos


if __name__ == "__main__":
    print("Tipo de gasto propuesto para la devolución de IVA")
    fallos = correr("por la actividad económica del SRI", ACTIVIDADES)
    fallos += correr("por el nombre del proveedor (grilla del portal)", NOMBRES)
    fallos += correr_cruce()
    sys.exit(1 if fallos else 0)
