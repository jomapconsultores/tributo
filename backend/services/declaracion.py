"""Cálculo de declaraciones (código SRI → valor) a partir de los datos cargados.
IVA = Formulario 104; ICE = Formulario ICE. Los mapeos de código son los
campos estándar del SRI; el contador debe verificarlos antes de presentar."""
from services.ice_calc import resumen_general as ice_audit_general
from services.ice_data import tax_params
from services.xml_parser import GASTOS_PERSONALES


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _es_personal(inv):
    return (inv.get("clasificacion") or "").upper() in GASTOS_PERSONALES


def _agg(invoices, key):
    """Suma el campo y cuenta cuántos comprobantes tienen valor > 0 en él."""
    total = 0.0
    n = 0
    for i in invoices:
        v = _f(i.get(key))
        if v > 0:
            total += v
            n += 1
    return total, n


def declaracion_iva(invoices, ventas_ice, ventas_iva=None):
    """Formulario 104.

    Compras: solo gastos del EJERCICIO (con derecho a crédito). Personales van al IR.

    Ventas: dos fuentes que se SUMAN — ambas declaran al mismo formulario pero
    se llevan en tablas distintas porque son impuestos distintos:
    - ventas_ice (tabla ice_sales): facturas con ICE. base_iva ya incluye el ICE
      en la base imponible (regla SRI ICE+IVA).
    - ventas_iva (tabla sales_iva): facturas SIN ICE, solo IVA. Resumen por
      factura con desglose por tarifa.
    """
    if ventas_iva is None:
        ventas_iva = []

    invoices = [i for i in invoices if (i.get("estado") or "OK") == "OK"]
    ejercicio = [i for i in invoices if not _es_personal(i)]
    personales_excluidos = sum(1 for i in invoices if _es_personal(i))

    # ── Compras del EJERCICIO (con derecho a crédito) ────────────────────
    c_base_15, c_n_base_15 = _agg(ejercicio, "base_15")
    c_iva_15, _            = _agg(ejercicio, "iva_15")
    c_base_5, c_n_base_5   = _agg(ejercicio, "base_5")
    c_iva_5, _             = _agg(ejercicio, "iva_5")
    c_base_0, c_n_base_0   = _agg(ejercicio, "base_0")
    c_no_obj, c_n_no_obj   = _agg(ejercicio, "no_objeto_iva")
    c_exento, c_n_exento   = _agg(ejercicio, "exento_iva")
    iva_compras = c_iva_15 + c_iva_5

    # ── Ventas con ICE (tabla ice_sales) ─────────────────────────────────
    # base_iva ya incluye el ICE en la base; valor_iva es 15% sobre esa base.
    v_ice_solo_ok = [v for v in ventas_ice if (v.get("estado") or "OK") == "OK"]
    v_ice_base_15 = sum(_f(v.get("base_iva")) for v in v_ice_solo_ok)
    v_ice_iva_15  = sum(_f(v.get("valor_iva")) for v in v_ice_solo_ok)
    n_ventas_ice  = sum(1 for v in v_ice_solo_ok if _f(v.get("base_iva")) > 0 or _f(v.get("valor_iva")) > 0)

    # ── Ventas sin ICE (tabla sales_iva) ─────────────────────────────────
    v_iva_solo_ok = [v for v in ventas_iva if (v.get("estado") or "OK") == "OK"]
    v_base_15, v_n_base_15 = _agg(v_iva_solo_ok, "base_15")
    v_iva_15,  _           = _agg(v_iva_solo_ok, "iva_15")
    v_base_5,  v_n_base_5  = _agg(v_iva_solo_ok, "base_5")
    v_iva_5,   _           = _agg(v_iva_solo_ok, "iva_5")
    v_base_0,  v_n_base_0  = _agg(v_iva_solo_ok, "base_0")
    v_no_obj,  v_n_no_obj  = _agg(v_iva_solo_ok, "no_objeto_iva")
    v_exento,  v_n_exento  = _agg(v_iva_solo_ok, "exento_iva")

    # ── Totales de ventas (suma ambas fuentes) ───────────────────────────
    t_base_15 = v_ice_base_15 + v_base_15      # 411: ICE incluye su parte, IVA puro suma 15%
    t_iva_15  = v_ice_iva_15 + v_iva_15        # 421
    t_base_5  = v_base_5                       # 412 (ICE casi siempre es 15%)
    t_iva_5   = v_iva_5                        # 422
    t_base_0  = v_base_0                       # 413
    t_exento  = v_exento                       # 414
    t_no_obj  = v_no_obj                       # 415
    iva_ventas = t_iva_15 + t_iva_5
    iva_pagar = max(0.0, iva_ventas - iva_compras)

    def fila(seccion, codigo, concepto, valor, n=None):
        f = {"seccion": seccion, "codigo": codigo, "concepto": concepto, "valor": round(valor, 2)}
        if n is not None:
            f["num_comprobantes"] = n
        return f

    filas = [
        # ── VENTAS ──
        fila("VENTAS", "411", "Ventas locales gravadas 15% (valor neto, ICE+IVA incluido en base)", t_base_15, n_ventas_ice + v_n_base_15),
        fila("VENTAS", "412", "Ventas locales gravadas 5% (valor neto)", t_base_5, v_n_base_5),
        fila("VENTAS", "413", "Ventas locales con tarifa 0%", t_base_0, v_n_base_0),
        fila("VENTAS", "414", "Ventas exentas de IVA", t_exento, v_n_exento),
        fila("VENTAS", "415", "Ventas no objeto del IVA", t_no_obj, v_n_no_obj),
        fila("VENTAS", "421", "IVA generado en ventas 15%", t_iva_15),
        fila("VENTAS", "422", "IVA generado en ventas 5%", t_iva_5),

        # ── ADQUISICIONES (solo gastos del ejercicio) ──
        fila("ADQUISICIONES", "510", "Adquisiciones gravadas 15% con derecho a crédito (valor neto)", c_base_15, c_n_base_15),
        fila("ADQUISICIONES", "520", "IVA en adquisiciones 15% (crédito tributario)", c_iva_15),
        fila("ADQUISICIONES", "550", "Adquisiciones gravadas 5% con derecho a crédito (valor neto)", c_base_5, c_n_base_5),
        fila("ADQUISICIONES", "560", "IVA en adquisiciones 5% (crédito tributario)", c_iva_5),
        fila("ADQUISICIONES", "517", "Adquisiciones y pagos gravados tarifa 0%", c_base_0, c_n_base_0),
        fila("ADQUISICIONES", "—", "Adquisiciones no objeto del IVA", c_no_obj, c_n_no_obj),
        fila("ADQUISICIONES", "—", "Adquisiciones exentas de IVA", c_exento, c_n_exento),

        # ── RESULTADO ──
        fila("RESULTADO", "564", "Crédito tributario por adquisiciones (IVA compras del ejercicio)", iva_compras),
        fila("RESULTADO", "499", "IVA a pagar estimado (421+422 − crédito 564)", iva_pagar),
    ]
    return {
        "tipo": "IVA",
        "filas": filas,
        "resumen": {
            "iva_ventas": round(iva_ventas, 2),
            "iva_compras": round(iva_compras, 2),
            "iva_pagar": round(iva_pagar, 2),
            "num_facturas_ejercicio": len(ejercicio),
            "num_facturas_personales_excluidas": personales_excluidos,
            "num_ventas_ice": n_ventas_ice,
            "num_ventas_iva_solo": len(v_iva_solo_ok),
        },
    }


def declaracion_ice(ice_rows, anio):
    """Formulario ICE para bebidas alcohólicas (SRI).
    - ICE específico: tarifa por litro de alcohol puro × litros de alcohol puro.
    - ICE ad valorem: 75% del exceso del precio/litro sobre el umbral.
    Se apoya en la auditoría de ICE (específico + ad valorem) del año."""
    g = ice_audit_general(ice_rows, anio)
    tax = tax_params(anio)
    esp = tax.get("esp", 0.0)
    # Base imponible (ad valorem) = precio ex-fábrica de venta
    base = sum(_f(r.get("base_ice")) or _f(r.get("precio_total_sin_impuesto")) for r in ice_rows)
    # Volumen = LITROS DE ALCOHOL PURO (litros de bebida × grado/100)
    litros_alcohol = sum(
        _f(r.get("unidades_botellas")) * (_f(r.get("capacidad")) / 1000.0) * (_f(r.get("grado_alcoholico")) / 100.0)
        for r in ice_rows
    )
    ice_esp = g.get("ice_especifico", 0.0)
    ice_adv = g.get("ice_advalorem", 0.0)
    total_ice = g.get("total_ice", 0.0)

    filas = [
        {"seccion": "AD VALOREM", "codigo": "303", "concepto": "Base imponible bruta (precio ex-fábrica)", "valor": round(base, 2)},
        {"seccion": "AD VALOREM", "codigo": "305", "concepto": "Porcentaje tarifa ad valorem", "valor": 0.75},
        {"seccion": "AD VALOREM", "codigo": "309", "concepto": "ICE causado ad valorem", "valor": round(ice_adv, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "314", "concepto": "Volumen neto (litros de alcohol puro)", "valor": round(litros_alcohol, 4)},
        {"seccion": "ESPECÍFICO", "codigo": "315", "concepto": "Tarifa específica (por litro de alcohol puro)", "valor": round(esp, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "319", "concepto": "ICE causado específico", "valor": round(ice_esp, 2)},
        {"seccion": "RESULTADO", "codigo": "399", "concepto": "TOTAL ICE CAUSADO", "valor": round(total_ice, 2)},
        {"seccion": "RESULTADO", "codigo": "499", "concepto": "TOTAL ICE A PAGAR", "valor": round(total_ice, 2)},
    ]
    return {
        "tipo": "ICE",
        "filas": filas,
        "resumen": {"ice_especifico": round(ice_esp, 2), "ice_advalorem": round(ice_adv, 2), "total_ice": round(total_ice, 2)},
    }
