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
    """Formulario 104. Adquisiciones desde 'gastos' (facturas de compra) y
    ventas desde ventas con ICE (si las hay).

    El IVA de gastos PERSONALES no genera crédito tributario (no es del giro
    del negocio); solo los gastos del EJERCICIO dan crédito. Las bases de
    ambos se reportan en sus casilleros respectivos."""
    invoices = [i for i in invoices if (i.get("estado") or "OK") == "OK"]
    ejercicio = [i for i in invoices if not _es_personal(i)]
    personales = [i for i in invoices if _es_personal(i)]

    # ── Gastos del EJERCICIO (con derecho a crédito) ────────────────────
    base_15_ej, n_base_15_ej = _agg(ejercicio, "base_15")
    iva_15_ej, _             = _agg(ejercicio, "iva_15")
    base_5_ej, n_base_5_ej   = _agg(ejercicio, "base_5")
    iva_5_ej, _              = _agg(ejercicio, "iva_5")
    base_0_ej, n_base_0_ej   = _agg(ejercicio, "base_0")
    no_obj_ej, n_no_obj_ej   = _agg(ejercicio, "no_objeto_iva")
    exento_ej, n_exento_ej   = _agg(ejercicio, "exento_iva")

    # ── Gastos PERSONALES (sin derecho a crédito) ───────────────────────
    base_15_per, n_base_15_per = _agg(personales, "base_15")
    iva_15_per, _              = _agg(personales, "iva_15")
    base_5_per, n_base_5_per   = _agg(personales, "base_5")
    iva_5_per, _               = _agg(personales, "iva_5")

    # ── Crédito tributario: solo IVA de gastos del ejercicio ────────────
    iva_compras = iva_15_ej + iva_5_ej
    iva_compras_sin_credito = iva_15_per + iva_5_per

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

        # ── ADQUISICIONES — GASTOS DEL EJERCICIO (con crédito tributario) ──
        fila("ADQUISICIONES — EJERCICIO", "510", "Adquisiciones gravadas 15% con derecho a crédito (valor neto)", base_15_ej, n_base_15_ej),
        fila("ADQUISICIONES — EJERCICIO", "520", "IVA en adquisiciones 15% (crédito tributario)", iva_15_ej),
        fila("ADQUISICIONES — EJERCICIO", "550", "Adquisiciones gravadas 5% con derecho a crédito (valor neto)", base_5_ej, n_base_5_ej),
        fila("ADQUISICIONES — EJERCICIO", "560", "IVA en adquisiciones 5% (crédito tributario)", iva_5_ej),
        fila("ADQUISICIONES — EJERCICIO", "517", "Adquisiciones y pagos gravados tarifa 0%", base_0_ej, n_base_0_ej),
        fila("ADQUISICIONES — EJERCICIO", "—", "Adquisiciones no objeto del IVA", no_obj_ej, n_no_obj_ej),
        fila("ADQUISICIONES — EJERCICIO", "—", "Adquisiciones exentas de IVA", exento_ej, n_exento_ej),

        # ── ADQUISICIONES — GASTOS PERSONALES (sin crédito tributario) ──
        fila("ADQUISICIONES — PERSONALES", "—", "Adquisiciones gravadas 15% sin derecho a crédito (valor neto)", base_15_per, n_base_15_per),
        fila("ADQUISICIONES — PERSONALES", "—", "IVA en adquisiciones personales 15% (no genera crédito)", iva_15_per),
        fila("ADQUISICIONES — PERSONALES", "—", "Adquisiciones gravadas 5% sin derecho a crédito (valor neto)", base_5_per, n_base_5_per),
        fila("ADQUISICIONES — PERSONALES", "—", "IVA en adquisiciones personales 5% (no genera crédito)", iva_5_per),

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
            "iva_compras_sin_credito": round(iva_compras_sin_credito, 2),
            "iva_pagar": round(iva_pagar, 2),
            "num_facturas_ejercicio": len(ejercicio),
            "num_facturas_personales": len(personales),
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
