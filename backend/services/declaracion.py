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


def declaracion_iva(invoices, ventas_ice):
    """Formulario 104. Solo se reportan los gastos del EJERCICIO (giro del
    negocio): son los que dan derecho a crédito tributario. Los gastos
    PERSONALES quedan fuera de esta declaración (van al Impuesto a la Renta
    como deducción personal, no al 104)."""
    invoices = [i for i in invoices if (i.get("estado") or "OK") == "OK"]
    ejercicio = [i for i in invoices if not _es_personal(i)]
    personales_excluidos = sum(1 for i in invoices if _es_personal(i))

    # ── Gastos del EJERCICIO (con derecho a crédito) ────────────────────
    base_15, n_base_15 = _agg(ejercicio, "base_15")
    iva_15, _          = _agg(ejercicio, "iva_15")
    base_5, n_base_5   = _agg(ejercicio, "base_5")
    iva_5, _           = _agg(ejercicio, "iva_5")
    base_0, n_base_0   = _agg(ejercicio, "base_0")
    no_obj, n_no_obj   = _agg(ejercicio, "no_objeto_iva")
    exento, n_exento   = _agg(ejercicio, "exento_iva")
    iva_compras = iva_15 + iva_5

    # ── Ventas ──────────────────────────────────────────────────────────
    base_ventas = sum(_f(v.get("base_iva")) for v in ventas_ice)
    iva_ventas = sum(_f(v.get("valor_iva")) for v in ventas_ice)
    n_ventas = sum(1 for v in ventas_ice if _f(v.get("base_iva")) > 0 or _f(v.get("valor_iva")) > 0)
    iva_pagar = max(0.0, iva_ventas - iva_compras)

    def fila(seccion, codigo, concepto, valor, n=None):
        f = {"seccion": seccion, "codigo": codigo, "concepto": concepto, "valor": round(valor, 2)}
        if n is not None:
            f["num_comprobantes"] = n
        return f

    filas = [
        # ── VENTAS ──
        fila("VENTAS", "411", "Ventas locales gravadas tarifa dif. de 0% (valor neto)", base_ventas, n_ventas),
        fila("VENTAS", "421", "IVA generado en ventas", iva_ventas),

        # ── ADQUISICIONES (solo gastos del ejercicio) ──
        fila("ADQUISICIONES", "510", "Adquisiciones gravadas 15% con derecho a crédito (valor neto)", base_15, n_base_15),
        fila("ADQUISICIONES", "520", "IVA en adquisiciones 15% (crédito tributario)", iva_15),
        fila("ADQUISICIONES", "550", "Adquisiciones gravadas 5% con derecho a crédito (valor neto)", base_5, n_base_5),
        fila("ADQUISICIONES", "560", "IVA en adquisiciones 5% (crédito tributario)", iva_5),
        fila("ADQUISICIONES", "517", "Adquisiciones y pagos gravados tarifa 0%", base_0, n_base_0),
        fila("ADQUISICIONES", "—", "Adquisiciones no objeto del IVA", no_obj, n_no_obj),
        fila("ADQUISICIONES", "—", "Adquisiciones exentas de IVA", exento, n_exento),

        # ── RESULTADO ──
        fila("RESULTADO", "564", "Crédito tributario por adquisiciones (IVA compras del ejercicio)", iva_compras),
        fila("RESULTADO", "499", "IVA a pagar estimado (421 − crédito 564)", iva_pagar),
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
