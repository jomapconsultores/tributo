# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Parser de facturas de venta de LICORES (ICE) desde el PDF (RIDE del SRI).

Se usa cuando el XML no está disponible — típico de las facturas emitidas por el
FACTURADOR del SRI, que no deja bajar el XML. Devuelve los mismos registros que
`parse_ice_invoice` (uno por línea de detalle) para guardarlos en `ice_sales`.

DOS DIFERENCIAS CON EL XML, que hay que tener presentes:

1. El RIDE **no trae el ICE por línea**: solo el ICE TOTAL del comprobante, abajo
   junto a los subtotales. Acá se reparte entre las líneas en proporción al precio
   de cada una (y el redondeo sobrante se ajusta en la última, para que la suma dé
   exacta la del comprobante).
2. El texto del RIDE sale con las columnas desordenadas — depende de cómo lo
   generó el emisor. Por eso cada línea se arma buscando la terna
   cantidad x precio_unitario = precio_total entre los números de la fila: si esa
   cuenta no cierra, la línea se descarta en vez de inventar valores.

Las filas quedan marcadas con `origen='pdf'` para poder revisarlas antes de
generar el anexo.
"""
import io
import re
from typing import Dict, List

import PyPDF2

from services.ice_data import buscar_en_catalogo, es_pack, get_botellas_por_caja
from services.ice_anexo import _extraer_grado, _extraer_volumen

# Fin del bloque de detalle: lo que viene después son totales o datos del pie.
_FIN_DETALLE = re.compile(
    r"informaci[oó]n\s+adicional|forma\s+de\s+pago|subtotal\s+sin\s+impuestos", re.I)
# Arranque del bloque de detalle (cabecera de la grilla del RIDE).
_INI_DETALLE = re.compile(r"precio\s*unitario|cod\.?\s*\n?\s*principal", re.I)

_NUM = re.compile(r"\d+(?:\.\d+)?")


def _texto_pdf(pdf_bytes: bytes) -> str:
    reader = PyPDF2.PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def _total_etiqueta(texto: str, etiqueta: str) -> float:
    """Importe que acompaña a una etiqueta de los totales ('353.47 ICE').
    El RIDE los escribe con el número ANTES de la etiqueta."""
    pat = re.compile(r"([\d]+\.\d{2})\s*" + etiqueta, re.I)
    m = pat.search(texto)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return 0.0
    return 0.0


def _clave_acceso(texto: str) -> str:
    m = re.search(r"(?:^|\D)(\d{49})(?:\D|$)", texto)
    return m.group(1) if m else ""


def _fecha(texto: str) -> str:
    m = re.search(r"\b(\d{2}/\d{2}/\d{4})\b", texto)
    return m.group(1) if m else ""


def _comprador(texto: str) -> Dict[str, str]:
    """Identificación y razón social del comprador. En el RIDE la etiqueta y el
    valor quedan separados, así que se busca el identificador (13 dígitos de RUC,
    10 de cédula o los nueves del consumidor final) y se toma como nombre la línea
    de texto que lo precede."""
    lineas = [ln.strip() for ln in texto.splitlines()]
    for i, ln in enumerate(lineas):
        m = re.fullmatch(r"(\d{13}|\d{10}|9{13})", ln)
        if not m:
            continue
        ident = m.group(1)
        nombre = ""
        for j in range(i - 1, max(-1, i - 4), -1):
            cand = lineas[j]
            if cand and not re.fullmatch(r"[\d\s./:-]+", cand):
                nombre = re.sub(r".*?(?:Apellidos:|Gu[ií]a)", "", cand).strip()
                break
        if ident.startswith("9999999999"):
            return {"identificacion": ident, "razon_social": "CONSUMIDOR FINAL"}
        return {"identificacion": ident, "razon_social": (nombre or "CONSUMIDOR FINAL")[:120]}
    return {"identificacion": "9999999999999", "razon_social": "CONSUMIDOR FINAL"}


def _tipo_id(identificacion: str) -> str:
    n = len(identificacion or "")
    if identificacion.startswith("9999999999"):
        return "07"      # consumidor final
    if n == 13:
        return "04"      # RUC
    if n == 10:
        return "05"      # cédula
    return "06"


def _bloque_detalle(texto: str) -> str:
    ini = 0
    m = _INI_DETALLE.search(texto)
    if m:
        ini = m.end()
    fin = len(texto)
    m2 = _FIN_DETALLE.search(texto, ini)
    if m2:
        fin = m2.start()
    return texto[ini:fin]


def _candidatos(texto: str) -> List[float]:
    """Valores numéricos que puede haber en una fila.

    Dos trampas del RIDE, las dos vistas en facturas reales:
      · las columnas salen PEGADAS ('31.20786213527' es el precio total 31.20 y
        el código auxiliar 786213527), así que de cada número también se prueba
        su recorte a dos decimales;
      · la descripción trae números ('750ML', '15V', '(12U)') que no son columnas;
        se descartan solos porque no cierran la cuenta cantidad x precio = total.
    """
    vals = []
    for tok in _NUM.findall(texto.replace(",", "")):
        try:
            vals.append(float(tok))
        except ValueError:
            continue
        m = re.match(r"^(\d+\.\d{2})\d+$", tok)     # importe con la otra columna pegada
        if m:
            vals.append(float(m.group(1)))
    return vals


def _terna(nums: List[float]):
    """(cantidad, precio_unitario, precio_total) de una fila: la combinación que
    CUMPLE cantidad x precio_unitario = precio_total. Es la única verificación
    posible sin el XML y evita cargar cifras inventadas. Se prefiere la de mayor
    total, que es la fila completa y no un pedazo."""
    mejor = None
    for i, a in enumerate(nums):
        if a <= 0:
            continue
        for j, b in enumerate(nums):
            if i == j or b <= 0:
                continue
            prod = a * b
            for k, c in enumerate(nums):
                if k in (i, j) or c <= 0 or abs(prod - c) > max(0.02, c * 0.001):
                    continue
                # Cantidad = el factor entero (las cajas se venden en enteros);
                # si los dos lo son, la menor, que es lo habitual.
                if a == int(a) and b != int(b):
                    cant, punit = a, b
                elif b == int(b) and a != int(a):
                    cant, punit = b, a
                else:
                    cant, punit = min(a, b), max(a, b)
                if mejor is None or c > mejor[2]:
                    mejor = (cant, punit, c)
    return mejor


# Cierre de fila del RIDE: la línea termina con cantidad + descuento + subsidio,
# los tres importes con dos decimales ('...375 ML (1U)12.00 0.00 0.00').
_FIN_FILA = re.compile(r"(\d+\.\d{2})\s+(\d+\.\d{2})\s+(\d+\.\d{2})\s*$")


def _descripcion(lineas: List[str]) -> str:
    """Descripción del producto, sacándole SOLO los números de las columnas.

    Importa conservar los de la descripción —'15V 750ML (1U)'— porque de ahí
    salen el grado y el volumen, y con eso se calcula el ICE. Así que se quitan:
    el cierre de fila (cantidad/descuento/subsidio), los importes con decimales
    (precios, pegados o no) y los códigos sueltos de cuatro dígitos o más."""
    partes = []
    for l in lineas:
        l = _FIN_FILA.sub(" ", l)                 # cantidad + descuento + subsidio
        l = re.sub(r"\d+\.\d{2,}", " ", l)        # importes (incluye los pegados)
        l = re.sub(r"(?<![A-Za-z(])\b\d{4,}\b", " ", l)   # códigos de producto sueltos
        partes.append(l)
    return re.sub(r"\s+", " ", " ".join(partes)).strip(" -/")


def _monto_inicial(lineas: List[str]) -> float:
    """Precio total de la fila: el RIDE lo escribe PRIMERO, al inicio del bloque
    ('31.20786213527' = total 31.20 con el código auxiliar pegado atrás)."""
    for ln in lineas:
        m = re.match(r"\s*(\d+\.\d{2})", ln)
        if m:
            return float(m.group(1))
    return 0.0


def _fila_de(lineas: List[str], cant_tail) -> Dict:
    """Arma la fila de un bloque de líneas.

    Con el cierre de fila (cantidad) y el importe inicial (precio total) alcanza:
    el unitario sale de dividir, sin adivinar entre los números sueltos que deja
    la descripción ('750ML', '15V') ni entre las columnas pegadas ('00528.47' es
    el código 0052 seguido del precio 8.47). Si no hay cierre, se cae a buscar la
    terna que cuadre."""
    desc = _descripcion(lineas)
    if len(desc) < 4:
        return {}
    total = _monto_inicial(lineas)
    if cant_tail and cant_tail > 0 and total > 0:
        punit = round(total / cant_tail, 6)
        return {"cantidad": cant_tail, "precio_unitario": punit,
                "precio_total": round(total, 2), "descripcion": desc[:120]}
    cands = _candidatos("\n".join(lineas))
    mejor = _terna([c for c in cands if round(c, 2) == round(c, 6)] or cands)
    if not mejor:
        return {}
    return {"cantidad": mejor[0], "precio_unitario": mejor[1],
            "precio_total": mejor[2], "descripcion": desc[:120]}


def _filas(bloque: str) -> List[Dict]:
    """Corta el bloque de detalle en filas.

    Una fila del RIDE ocupa VARIAS líneas y con las columnas desordenadas, así que
    no sirve partir por línea. Se acumula hasta el CIERRE de fila (cantidad +
    descuento + subsidio al final de la línea) y recién ahí se arma, verificando
    que cantidad x precio_unitario dé el precio total. Si el emisor no usa ese
    cierre, se cae a acumular hasta que la cuenta cierre por sí sola.
    """
    lineas = [l for l in bloque.splitlines() if l.strip()]
    # Fuera lo que quede de la cabecera de la grilla: la primera fila empieza en
    # la primera línea que arranca con un importe.
    for i, ln in enumerate(lineas):
        if re.match(r"\s*\d+\.\d{2}", ln):
            lineas = lineas[i:]
            break
    filas, actual = [], []
    hubo_cierre = False
    for ln in lineas:
        actual.append(ln)
        m = _FIN_FILA.search(ln)
        if not m:
            continue
        hubo_cierre = True
        fila = _fila_de(actual, float(m.group(1)))
        if fila:
            filas.append(fila)
        actual = []
    if hubo_cierre:
        return filas

    # Sin cierres reconocibles: acumular hasta que la cuenta cierre sola.
    filas, actual = [], []
    for ln in lineas:
        actual.append(ln)
        fila = _fila_de(actual, None)
        if fila:
            filas.append(fila)
            actual = []
    return filas


def parse_ice_pdf(pdf_bytes: bytes) -> List[Dict]:
    """Registros para `ice_sales` (uno por línea), o [] si no se pudo leer."""
    try:
        texto = _texto_pdf(pdf_bytes)
    except Exception as e:
        print(f"No se pudo leer el PDF ICE: {e}")
        return []
    if not texto.strip():
        return []

    clave = _clave_acceso(texto)
    fecha = _fecha(texto)
    comp = _comprador(texto)
    ice_total = _total_etiqueta(texto, r"ICE\b")
    iva_total = _total_etiqueta(texto, r"IVA")
    importe_total = _total_etiqueta(texto, r"VALOR\s+TOTAL")

    filas = _filas(_bloque_detalle(texto))
    if not filas:
        return []

    # CUADRE OBLIGATORIO: la suma de las líneas leídas tiene que dar el subtotal
    # sin impuestos que el propio RIDE imprime. Si no da, el texto se leyó mal
    # (columnas pegadas, emisor con otro formato) y es preferible no cargar nada
    # antes que meter cifras equivocadas en una declaración.
    subtotal = _total_etiqueta(texto, r"SUBTOTAL\s+SIN\s+IMPUESTOS")
    suma = round(sum(f["precio_total"] for f in filas), 2)
    if subtotal and abs(suma - subtotal) > 0.05:
        print(f"PDF ICE descartado: las líneas suman {suma} y el RIDE dice {subtotal}")
        return []

    base = clave or re.sub(r"\W", "", (comp["identificacion"] + fecha))[:32]
    suma_precios = sum(f["precio_total"] for f in filas) or 1.0

    registros = []
    ice_repartido = 0.0
    for idx, f in enumerate(filas, start=1):
        desc = f["descripcion"]
        cant = f["cantidad"]
        p_unit = f["precio_unitario"]
        p_total = f["precio_total"]

        # El ICE del comprobante se reparte por peso del precio de cada línea; la
        # última se lleva el resto para que la suma cuadre exacta con el RIDE.
        if idx < len(filas):
            ice = round(ice_total * (p_total / suma_precios), 2)
            ice_repartido += ice
        else:
            ice = round(ice_total - ice_repartido, 2)

        bot_por_caja = get_botellas_por_caja(desc)
        cat = buscar_en_catalogo(desc)
        vol_nombre = _extraer_volumen(desc)
        grado_nombre = _extraer_grado(desc)
        precio_por_caja = p_total / cant if cant > 0 else p_unit
        precio_por_botella = precio_por_caja / bot_por_caja if bot_por_caja > 0 else precio_por_caja
        base_iva = round(p_total + ice, 2)

        registros.append({
            "unique_id": f"{base}-{idx}",
            "estado": "OK",
            "origen": "pdf",
            "fecha": fecha,
            "tipo_id_cliente": _tipo_id(comp["identificacion"]),
            "id_cliente": comp["identificacion"],
            "razon_social_cliente": comp["razon_social"],
            "codigo_producto": "",
            "nombre_producto": desc,
            "cod_marca": cat["codMarca"],
            "presentacion": cat["presentacion"],
            "capacidad": vol_nombre or cat["capacidad"],
            "unidad": cat["unidad"],
            "grado_alcoholico": grado_nombre or cat["grado"],
            "cod_impuesto": cat["codImpuesto"],
            "tipo_producto": cat["tipo"],
            "es_pack": es_pack(desc),
            "botellas_por_caja": bot_por_caja,
            "cantidad_cajas": round(cant, 2),
            "unidades_botellas": int(cant * bot_por_caja),
            "precio_unitario": round(p_unit, 4),
            "precio_total_sin_impuesto": round(p_total, 2),
            "precio_por_caja": round(precio_por_caja, 4),
            "precio_por_botella": round(precio_por_botella, 4),
            "base_ice": round(p_total, 2),
            "valor_ice": ice,
            "base_iva": base_iva,
            "valor_iva": round(iva_total * (p_total / suma_precios), 2) if iva_total else 0.0,
            "importe_total": round(importe_total, 2),
        })
    return registros
