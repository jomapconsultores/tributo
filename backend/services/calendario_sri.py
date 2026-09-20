# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Calendario tributario del SRI (Ecuador) en el servidor.

La fecha máxima de declaración (IVA Form. 104, Retenciones Form. 103, ICE
Form. 113) depende del NOVENO dígito del RUC/identificación:

      9no dígito -> día máximo        9no dígito -> día máximo
        1 -> 10                         6 -> 20
        2 -> 12                         7 -> 22
        3 -> 14                         8 -> 24
        4 -> 16                         9 -> 26
        5 -> 18                         0 -> 28

Si ese día cae en sábado, domingo o día de descanso obligatorio, el SRI corre el
plazo al siguiente día hábil.

POR QUÉ EXISTE ESTE ARCHIVO
---------------------------
Esta cuenta ya vivía en el frontend (`frontend/src/utils/declaracionSRI.js` y
`frontend/src/utils/feriadosEC.js`), que es lo que ve el contribuyente en
pantalla. El recordatorio por correo lo manda un cron, sin navegador, así que la
misma cuenta hace falta en Python.

Son dos copias de una sola regla, y eso solo es seguro si dan el MISMO día: si
el correo dijera una fecha y la pantalla otra, el contribuyente no sabría a cuál
creerle. Por eso `scripts/test_calendario_sri.py` compara esta implementación
contra los casos del calendario oficial. Al tocar cualquiera de los dos lados,
corre ese test.
"""
from datetime import date, timedelta

# Día máximo (10-28) según el noveno dígito del RUC.
DIA_POR_DIGITO = {1: 10, 2: 12, 3: 14, 4: 16, 5: 18,
                  6: 20, 7: 22, 8: 24, 9: 26, 0: 28}

# Días no laborables declarados por Decreto Ejecutivo (puentes, censos, etc.).
# No se pueden deducir por regla: se agregan a mano, 'YYYY-MM-DD'.
# Debe reflejar FERIADOS_DECRETADOS de `frontend/src/utils/feriadosEC.js`.
FERIADOS_DECRETADOS = {
    "2026-04-30": "Día no laborable (Decreto Ejecutivo)",
}

MESES = ("enero", "febrero", "marzo", "abril", "mayo", "junio",
         "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre")


# --- noveno dígito ----------------------------------------------------------

def noveno_digito(ruc):
    """Noveno dígito (índice 8) del RUC/cédula. None si no sirve."""
    if not ruc:
        return None
    s = str(ruc).strip()
    if len(s) < 9 or not s.isdigit():
        return None
    return int(s[8])


def dia_declaracion(ruc):
    """Día máximo (10-28) de declaración según el 9no dígito. None si inválido."""
    d = noveno_digito(ruc)
    if d is None:
        return None
    return DIA_POR_DIGITO.get(d)


# --- feriados ---------------------------------------------------------------

def domingo_pascua(anio):
    """Domingo de Pascua (gregoriano) — algoritmo de Meeus/Jones/Butcher."""
    a = anio % 19
    b = anio // 100
    c = anio % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    ll = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ll) // 451
    mes = (h + ll - 7 * m + 114) // 31          # 3 = marzo, 4 = abril
    dia = ((h + ll - 7 * m + 114) % 31) + 1
    return date(anio, mes, dia)


def _dia_js(f):
    """Día de la semana al estilo JS: 0 domingo … 6 sábado."""
    return (f.weekday() + 1) % 7


def _trasladar_descanso(f):
    """Día de descanso obligatorio que corresponde a un feriado trasladable.

    Cuando un feriado se traslada, el día ORIGINAL vuelve a ser laborable y el
    descanso —y con él la prórroga del plazo— cae en el día trasladado."""
    dj = _dia_js(f)
    if dj == 2:                      # martes    -> lunes anterior
        return f - timedelta(days=1)
    if dj == 3:                      # miércoles -> viernes posterior
        return f + timedelta(days=2)
    if dj == 4:                      # jueves    -> viernes posterior
        return f + timedelta(days=1)
    if dj == 6:                      # sábado    -> viernes anterior
        return f - timedelta(days=1)
    if dj == 0:                      # domingo   -> lunes posterior
        return f + timedelta(days=1)
    return f                         # lunes / viernes: se mantiene


_cache_feriados = {}


def feriados_de_anio(anio):
    """Días de descanso obligatorio del año (ya trasladados), como
    dict {'YYYY-MM-DD': nombre del feriado}. Se memoriza por año."""
    if anio in _cache_feriados:
        return _cache_feriados[anio]

    pascua = domingo_pascua(anio)
    mapa = {}

    def poner(fecha, nombre):
        # El 2 y el 3 de noviembre pueden caer en el mismo día tras el traslado;
        # la ley mantiene los dos descansos, así que se corren a días
        # consecutivos. (Nunca alcanzan el rango 10-28 que usa el SRI.)
        f = fecha
        while f.isoformat() in mapa:
            f = f + timedelta(days=1)
        mapa[f.isoformat()] = nombre

    # Inamovibles
    poner(date(anio, 1, 1), "Año Nuevo")
    poner(pascua - timedelta(days=48), "Carnaval (lunes)")
    poner(pascua - timedelta(days=47), "Carnaval (martes)")
    poner(pascua - timedelta(days=2), "Viernes Santo")
    poner(date(anio, 12, 25), "Navidad")

    # Trasladables
    poner(_trasladar_descanso(date(anio, 5, 1)), "Día del Trabajo")
    poner(_trasladar_descanso(date(anio, 5, 24)), "Batalla de Pichincha")
    poner(_trasladar_descanso(date(anio, 8, 10)), "Primer Grito de Independencia")
    poner(_trasladar_descanso(date(anio, 10, 9)), "Independencia de Guayaquil")
    poner(_trasladar_descanso(date(anio, 11, 2)), "Día de los Difuntos")
    poner(_trasladar_descanso(date(anio, 11, 3)), "Independencia de Cuenca")

    # Decretados
    for clave, nombre in FERIADOS_DECRETADOS.items():
        if clave.startswith(f"{anio}-") and clave not in mapa:
            mapa[clave] = nombre

    _cache_feriados[anio] = mapa
    return mapa


def es_feriado(fecha):
    """Nombre del feriado si esa fecha es de descanso obligatorio; None si no."""
    return feriados_de_anio(fecha.year).get(fecha.isoformat())


def es_fin_de_semana(fecha):
    return _dia_js(fecha) in (0, 6)


def es_dia_no_habil(fecha):
    return es_fin_de_semana(fecha) or es_feriado(fecha) is not None


def motivo_no_habil(fecha):
    """'sábado', 'domingo' o el nombre del feriado. None si el día es hábil."""
    dj = _dia_js(fecha)
    if dj == 6:
        return "sábado"
    if dj == 0:
        return "domingo"
    return es_feriado(fecha)


def siguiente_dia_habil(fecha):
    """Primer día hábil en o después de `fecha`. Salta fines de semana y
    feriados encadenados (p. ej. viernes feriado + sábado + domingo)."""
    d = fecha
    # Cota de seguridad: ninguna cadena real de días no hábiles pasa de ~10 días.
    for _ in range(15):
        if not es_dia_no_habil(d):
            break
        d = d + timedelta(days=1)
    return d


def traslado_dia_habil(fecha):
    """Traslado aplicado a una fecha límite.

    Devuelve {'fecha', 'original', 'dias', 'motivo'}; `dias` es 0 si el día base
    ya era hábil y `motivo` dice qué lo corrió."""
    habil = siguiente_dia_habil(fecha)
    dias = (habil - fecha).days
    return {"fecha": habil, "original": fecha, "dias": dias,
            "motivo": None if dias == 0 else motivo_no_habil(fecha)}


# --- fechas límite ----------------------------------------------------------

def mes_declaracion_semestre(semestre, anio):
    """Mes/año de calendario en que se declara un semestre.
    S1 (ENE-JUN) del año Y → julio Y; S2 (JUL-DIC) del año Y → enero (Y+1)."""
    a = int(anio)
    return (7, a) if int(semestre) == 1 else (1, a + 1)


def fecha_limite_mensual(ruc, hoy=None):
    """Fecha máxima para declarar el MES ANTERIOR (en Ecuador se declara el mes
    vencido): el día del 9no dígito dentro del MES ACTUAL, corrido a día hábil.
    Devuelve el dict de `traslado_dia_habil`, o None si el RUC no sirve."""
    hoy = hoy or date.today()
    dia = dia_declaracion(ruc)
    if dia is None:
        return None
    return traslado_dia_habil(date(hoy.year, hoy.month, dia))


def fecha_limite_semestral(ruc, semestre, anio):
    """Fecha máxima para declarar un semestre ya cerrado, corrida a día hábil.
    Devuelve el dict de `traslado_dia_habil`, o None si falta el dato."""
    dia = dia_declaracion(ruc)
    if dia is None or not semestre or not anio:
        return None
    mes, a = mes_declaracion_semestre(semestre, anio)
    return traslado_dia_habil(date(a, mes, dia))


def _semestre_de(cliente):
    """Semestre (1|2) del contribuyente: el explícito, o el que deduce el mes ancla."""
    sem = cliente.get("periodo_semestre")
    if sem:
        return int(sem)
    return 1 if (int(cliente.get("periodo_mes") or 1) <= 6) else 2


def fecha_limite_cliente(cliente, hoy=None):
    """Fecha máxima de declaración del contribuyente según su periodicidad.

    `cliente` es una fila de `clients` (identificacion, periodicidad,
    periodo_semestre, periodo_anio, periodo_mes). Devuelve el dict de
    `traslado_dia_habil` más `periodo` (texto de lo que se declara), o None si
    no se puede calcular."""
    ruc = cliente.get("identificacion")
    if (cliente.get("periodicidad") or "mensual") == "semestral":
        sem = _semestre_de(cliente)
        anio = cliente.get("periodo_anio")
        t = fecha_limite_semestral(ruc, sem, anio)
        if t:
            t = dict(t)
            t["periodo"] = (f"{'1er' if sem == 1 else '2do'} semestre {anio} "
                            f"({'enero a junio' if sem == 1 else 'julio a diciembre'})")
        return t
    t = fecha_limite_mensual(ruc, hoy)
    if t:
        hoy = hoy or date.today()
        # Se declara el mes ANTERIOR al actual.
        m = hoy.month - 1
        a = hoy.year
        if m < 1:
            m, a = 12, a - 1
        t = dict(t)
        t["periodo"] = f"{MESES[m - 1]} de {a}"
    return t


def fecha_texto_largo(f):
    """'10 de mayo de 2026' — igual que lo escribe el frontend."""
    return f"{f.day} de {MESES[f.month - 1]} de {f.year}"
