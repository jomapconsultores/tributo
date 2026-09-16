# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Arma el archivo que el portal del SRI acepta para LLENAR una declaración.

El formulario en línea (`sri-declaraciones-web-internet`) tiene su propia carga
por archivo: en el paso *Preguntas* hay un `<input type=file accept=.json,.xml>`
que lee un JSON de la forma

    {"detallesDeclaracion": {"<concepto>": "<valor>", ...}}

lo valida, lo deja en `sessionStorage` y, al pasar a *Formulario*, escribe cada
valor en el campo `id="concepto<concepto>"`. No presenta nada: el formulario
queda lleno para revisarlo, y guardar/enviar sigue siendo del usuario.

Lo que NO es obvio —y por eso existe este módulo—: el `concepto` no es el
casillero. El casillero 411 del IVA es el campo `concepto460`, el 303 del ICE es
`concepto140`. Las tablas de abajo se leyeron del portal real el 2026-09-16,
casillero por casillero: cada campo está en la celda contigua a la que muestra
su número. Las que el portal pinta de solo lectura (las calcula él) se marcan con
`*` y no se mandan: escribir ahí es pisar su cálculo.

Si el SRI cambia el formulario, la extensión lo detecta —comprueba en la página
que cada concepto siga al lado de su casillero— y avisa en vez de llenar mal.
"""

# casillero:concepto, con * los de solo lectura. Copiado tal cual del portal.
_PARES = {
    "IVA": (
        "203:91 401:450 411:460 421:470 402:510 412:520 422:530 410:451 420:461 430:471 425:452 "
        "435:462 445:472 423:2950 424:2955 403:570 413:580 404:610 414:620 405:670 415:680 406:700 "
        "416:710 407:790 417:800 408:810 418:820 409:860* 419:870* 429:880* 431:1038 441:1040 "
        "442:1050 443:1070 453:1080 434:1098 444:1100 454:1110 480:1200* 481:1210 482:1220* 483:1230 "
        "484:1240 485:1250* 486:1251* 487:1252* 499:1260* 111:252 113:254 500:1270 510:1280 520:1290 "
        "501:1390 511:1400 521:1410 530:1271 533:1281 534:1291 540:1261 550:1262 560:1263 502:1470 "
        "512:1550 522:1480 503:1552 513:1554 523:1556 504:1600 514:1610 524:1620 505:1640 515:1650 "
        "525:1660 526:2860 527:2865 506:1700 516:1710 507:1720 517:1730 508:1735 518:1740 509:1780* "
        "519:1790* 529:1800* 531:1818 541:1820 532:1823 542:1825 543:1830 544:1900 554:1910 535:1978 "
        "545:1980 555:1990 563:2110* 564:2130 565:1276 115:256 117:258 119:260 601:2140* 602:2150* "
        "603:2870 604:2880 605:2160 606:2170 607:2890 608:2900 623:1275 492:1282 609:2200 622:2951 "
        "610:2910 611:2920 612:2210 613:2212 614:2215 615:2220 617:2230 618:2930 619:2940 624:1278 "
        "625:1279 620:2250* 621:2260 699:2270* 700:2970 701:2980 702:2990 721:2515 723:2525 725:2520 "
        "727:2960 729:2530 731:2540 799:2550* 800:2555 802:3555 801:2565* 859:2560* 890:2570 897:2590 "
        "898:2580 899:2600 880:2605 881:2601* 882:2602 883:2603 884:2604 885:2606 886:2607 887:2608 "
        "902:2610* 903:2620 904:2630 999:2640*"
    ),
    "ICE": (
        "303:140 313:144 304:141 314:145 305:142* 315:146* 309:143 319:147 307:420 316:440 310:430* "
        "317:450* 311:412 318:460* 312:413 320:470* 330:421 326:415 331:422 328:417 329:418 321:148 "
        "399:150* 402:340 403:350* 404:360* 410:370* 411:380 498:390* 499:400* 890:170 897:480 "
        "898:490 899:500 902:180* 903:190 904:200 999:210*"
    ),
    "103": (
        "302:260 352:270 303:310 353:320 3030:7290 3530:7300 304:490 354:500 307:510 357:520 308:530 "
        "358:535 309:820 359:830 310:850 360:860 311:840 361:845 312:870 362:880 322:930 372:940 "
        "3120:6075 3620:6085 3121:7270 3621:7280 3430:7370 3450:7380 343:1420 393:1430 344:1440 "
        "394:1450 332:1410 314:570 364:580 3140:7310 3640:7320 319:890 369:900 320:910 370:920 "
        "323:950 373:960 324:955 374:965 3230:7360 325:1320 375:1330 3250:1345 326:1213 376:1214 "
        "327:1215 377:1216 328:1217 378:1218 329:1219 379:1220 330:1221 380:1222 331:1223 333:1235 "
        "383:1236 334:1237 384:1238 335:1240 385:1250 3482:7250 3481:7230 3981:7240 336:1260 "
        "386:1270 337:1280 387:1290 3370:7390 3870:7400 350:7010 400:7020 3440:6095 3940:7000 "
        "345:1460 395:1470 346:1485 396:1495 5300:6045 3400:6035 3900:6040 5100:6030 3380:6020 "
        "3880:6025 510:1295 338:1291 388:1292 520:1299 339:1297 389:1298 530:1283 340:1281 390:1282 "
        "540:1286 341:1284 391:1285 550:1289 342:1287 392:1288 3401:6036 3404:6038 3901:6037 "
        "3904:6039 3407:7800* 3999:7807* 3408:7900* 3995:7907* 3903:7801 3902:6041 3483:7330 "
        "3484:7340 3485:7350 3480:7210 3980:7220 3490:7211 3491:7213 3991:7212 3994:7214 3497:7805 "
        "3998:7808* 3498:7905 3997:7908* 3993:7806 3992:7221 349:1500* 399:1540* 402:3000 452:3005 "
        "403:3010 453:3015 404:3020 454:3025 405:3030 406:3035 456:3040 407:3045 457:3050 4050:7030 "
        "4550:7040 4060:7050 4560:7060 4070:7070 4570:7080 408:3055 458:3060 409:3065 459:3070 "
        "410:3075 460:3080 411:3085 461:3090 412:3095 413:1580 463:1590 414:1600 464:1610 415:4000 "
        "465:4005 416:4010 417:4015 467:4020 418:4025 468:4030 4160:7090 4660:7100 4170:7110 "
        "4670:7120 4180:7130 4680:7140 419:4035 469:4040 420:4045 470:4050 421:4055 471:4060 "
        "422:1620 472:1630 423:4065 424:1622 474:1632 425:5000 475:5005 426:5010 476:5015 427:5020 "
        "477:5025 428:5030 478:5035 4260:7150 4760:7160 4270:7170 4770:7180 4280:7190 4780:7200 "
        "429:5040 479:5045 430:5050 480:5055 431:5060 481:5065 432:1626 482:1636 433:1640 497:1650* "
        "498:2000* 499:2010* 500:2015 501:2025* 890:2230* 897:2250 898:2240 899:2260 880:2265 "
        "902:2270* 903:2280 904:2290 999:2410*"
    ),
}


def _tabla(pares):
    """casillero -> (concepto, editable)."""
    t = {}
    for par in pares.split():
        cas, con = par.split(":")
        t[cas] = (con.rstrip("*"), not con.endswith("*"))
    return t


CONCEPTOS = {tipo: _tabla(p) for tipo, p in _PARES.items()}

# Cómo se llama cada formulario en el portal: el grupo va en la URL de la
# aplicación y la obligación es el combo del primer paso.
GRUPO = {"IVA": "IVA", "ICE": "ICE", "103": "RETENC"}
OBLIGACION = {
    ("IVA", "mensual"): "2011",     # 2011 DECLARACION DE IVA
    ("IVA", "semestral"): "2021",   # 2021 - DECLARACIÓN SEMESTRAL IVA
    ("ICE", "mensual"): "3031",     # 3031 - ICE BEBIDAS ALCOHÓLICAS (lo que calcula el sistema)
    ("103", "mensual"): "1031",     # 1031 - DECLARACIÓN DE RETENCIONES EN LA FUENTE
}

URL_FORMULARIO = (
    "https://srienlinea.sri.gob.ec/sri-declaraciones-web-internet/pages/recepcion/recibirDeclaracion.jsf"
    "?identificadorGrupoObligacion={g}&contextoMPT=https://srienlinea.sri.gob.ec/tuportal-internet"
    "&pathMPT=&actualMPT=Formulario%20{t}%20&linkMPT=%2Fsri-declaraciones-web-internet%2Fpages"
    "%2Frecepcion%2FrecibirDeclaracion.jsf%3FidentificadorGrupoObligacion%3D{g}&esFavorito=S"
)
_TITULO_URL = {"IVA": "IVA", "ICE": "ICE", "103": "Retenciones"}


# ── IVA ──────────────────────────────────────────────────────────────────────
# Código del sistema -> casilleros oficiales. Una lista porque el formulario pide
# el VALOR BRUTO y el NETO en casilleros distintos, y el sistema solo tiene uno:
# sin notas de crédito registradas, bruto y neto son lo mismo.
# (Es la tabla de `declaracion_oficial.MAP_IVA` más el bruto; allá las exentas no
# tienen casillero porque la plantilla Excel no lo trae, acá sí: el portal junta
# no objeto y exentas en la misma fila 431/441.)
_IVA = {
    "411": ["401", "411"], "421": ["421"],
    "412": ["425", "435"], "422": ["445"],
    "420": ["410", "420"], "430": ["430"],
    "413": ["403", "413"],
    "414": ["431", "441"], "415": ["431", "441"],
    "510": ["500", "510"], "520": ["520"],
    "550": ["540", "550"], "560": ["560"],
    "533": ["530", "533"], "534": ["534"],
    "517": ["507", "517"],
    "518": ["531", "541"],
    "519": ["532", "542"],
}
# Filas del sistema que NO se trasladan aunque el formulario tenga un casillero
# con ese número: el sistema usa el código con otro sentido.
_IVA_OTRO_SENTIDO = {
    "480": "el sistema lo usa para el IVA diferido que vence; en el formulario 480 es el total de ventas al contado",
    "481": "ventas con cobro diferido: revisar a mano contra los casilleros 481-485 del formulario",
    "484": "IVA diferido de este mes: en el formulario va en 485, que el SRI calcula",
}

# ── ICE ──────────────────────────────────────────────────────────────────────
_ICE = {
    "303": ["303", "304"],   # base bruta = neta sin devoluciones
    "309": ["309"],
    "314": ["313", "314"],   # volumen bruto = neto sin devoluciones
    "319": ["319"],
    "EXE": ["326"],          # Exención ICE bebidas alcohólicas
}
_ICE_OTRO_SENTIDO = {
    "R-50": "la rebaja por tarifa reducida (318) la calcula el SRI con el volumen 316 y la tarifa 317",
    "DIF": "el diferimiento del pago no tiene casillero en el formulario",
    "903": "el sistema lo usa para el ICE diferido que vence; en el formulario 903 es el interés por mora",
    "904": "el sistema lo usa para el total del período; en el formulario 904 es la multa",
}

# ── 103 ──────────────────────────────────────────────────────────────────────
# Concepto de retención del sistema -> (casillero base, casillero retenido).
# Etiquetas leídas del formulario 2026 (reforma de tramos, NAC-DGERCGC26-00000009).
_103 = {
    "honorarios": ("303", "353"),
    "servicios_intelecto": ("304", "354"),
    "servicios_profesionales_sociedad": ("3030", "3530"),
    "servicios_mano_obra": ("307", "357"),
    "bienes_muebles": ("312", "362"),
    "arrendamiento": ("320", "370"),
    "arrendamiento_mercantil": ("319", "369"),
    "seguros": ("322", "372"),
    "rendimientos": ("323", "373"),
    "transporte": ("310", "360"),
    "agropecuario_productor": ("3120", "3620"),
    "agropecuario_comercializador": ("3121", "3621"),
    "construccion": ("3430", "3450"),
    "otros_1": ("343", "393"),
    "otros_2": ("344", "394"),
    "otros_3": ("3440", "3940"),
    "otros_5": ("346", "396"),      # "Aplicables a otros porcentajes"
    "otros_10": ("346", "396"),
}
_103_SIN_CASILLERO = {
    "rendimientos_bancarios": "intereses a bancos: el formulario los separa (324 entre instituciones financieras / 3230 otros al 0%)",
    "otro": "concepto libre: hay que elegir el casillero a mano",
}


def _monto(v):
    try:
        return round(float(v or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def _acumular(destino, casillero, valor):
    destino[casillero] = round(destino.get(casillero, 0.0) + valor, 2)


def _periodo(decl):
    c = decl.get("cliente") or {}
    periodicidad = (c.get("periodicidad") or "mensual").lower()
    return {
        "periodicidad": periodicidad,
        "anio": int(decl.get("anio") or c.get("periodo_anio") or 0),
        "mes": int(decl.get("mes") or c.get("periodo_mes") or 0),
        "semestre": int(c["periodo_semestre"]) if c.get("periodo_semestre") else None,
        "etiqueta": decl.get("periodo_label") or "",
    }


def _casilleros_iva(decl, no_trasladados):
    por_casillero = {}
    for f in decl.get("filas", []):
        cod = str(f.get("codigo", "")).strip()
        valor = _monto(f.get("valor"))
        if not valor:
            continue
        if cod in _IVA_OTRO_SENTIDO:
            no_trasladados.append({"codigo": cod, "valor": valor, "descripcion": f.get("concepto", ""),
                                   "motivo": _IVA_OTRO_SENTIDO[cod]})
            continue
        # Ventas y adquisiciones van por la tabla; el resultado y la sección de
        # agente de retención ya usan el número oficial.
        destinos = _IVA.get(cod) or (None if f.get("seccion") in ("VENTAS", "ADQUISICIONES") else [cod])
        if not destinos:
            no_trasladados.append({"codigo": cod, "valor": valor, "descripcion": f.get("concepto", ""),
                                   "motivo": "sin casillero equivalente en el formulario"})
            continue
        for cas in destinos:
            _acumular(por_casillero, cas, valor)
    return por_casillero


def _casilleros_ice(decl, no_trasladados):
    por_casillero = {}
    for f in decl.get("filas", []):
        cod = str(f.get("codigo", "")).strip()
        valor = _monto(f.get("valor"))
        if not valor:
            continue
        if cod in _ICE_OTRO_SENTIDO:
            no_trasladados.append({"codigo": cod, "valor": valor, "descripcion": f.get("concepto", ""),
                                   "motivo": _ICE_OTRO_SENTIDO[cod]})
            continue
        for cas in _ICE.get(cod, [cod]):
            _acumular(por_casillero, cas, valor)
    return por_casillero


def _casilleros_103(decl, no_trasladados, conceptos_renta):
    """El 103 del sistema viene agrupado por la ETIQUETA del concepto (así se
    guarda en retenciones_efectuadas); se vuelve a la clave para saber el
    casillero."""
    clave_de = {c["label"]: c["key"] for c in conceptos_renta}
    por_casillero = {}
    for item in (decl.get("resumen") or {}).get("por_concepto", []):
        etiqueta = item.get("concepto") or ""
        base, ret = _monto(item.get("base")), _monto(item.get("retenido"))
        if not base and not ret:
            continue
        clave = clave_de.get(etiqueta)
        if clave in _103:
            cas_base, cas_ret = _103[clave]
            _acumular(por_casillero, cas_base, base)
            _acumular(por_casillero, cas_ret, ret)
            continue
        motivo = _103_SIN_CASILLERO.get(clave, "concepto sin casillero conocido en el formulario")
        no_trasladados.append({"codigo": "", "valor": ret, "descripcion": f"{etiqueta} (base {base:.2f})",
                               "motivo": motivo})
    return por_casillero


def armar_carga(tipo, decl, conceptos_renta=None):
    """Paquete para la extensión: el archivo del portal y todo lo que hace falta
    para llegar a él (grupo, obligación, período) y comprobar que llenó bien."""
    tipo = str(tipo).upper()
    if tipo not in CONCEPTOS:
        raise ValueError(f"El formulario {tipo} no se puede cargar en el portal del SRI.")
    periodo = _periodo(decl)
    obligacion = OBLIGACION.get((tipo, periodo["periodicidad"]))
    if not obligacion:
        raise ValueError(f"No hay obligación {periodo['periodicidad']} de {tipo} en el portal del SRI.")

    no_trasladados = []
    if tipo == "IVA":
        por_casillero = _casilleros_iva(decl, no_trasladados)
    elif tipo == "ICE":
        por_casillero = _casilleros_ice(decl, no_trasladados)
    else:
        por_casillero = _casilleros_103(decl, no_trasladados, conceptos_renta or [])

    tabla = CONCEPTOS[tipo]
    casilleros, detalles, calculados = [], {}, []
    for cas in sorted(por_casillero, key=lambda x: (len(x), x)):
        valor = por_casillero[cas]
        if not valor:
            continue
        if cas not in tabla:
            no_trasladados.append({"codigo": cas, "valor": valor, "descripcion": "",
                                   "motivo": "el formulario del portal no tiene ese casillero"})
            continue
        concepto, editable = tabla[cas]
        if not editable:
            # Lo calcula el portal con lo demás: no es una omisión, es su resultado.
            calculados.append({"casillero": cas, "valor": valor})
            continue
        detalles[concepto] = f"{valor:.2f}"
        casilleros.append({"casillero": cas, "concepto": concepto, "valor": valor})

    c = decl.get("cliente") or {}
    ruc = "".join(ch for ch in str(c.get("identificacion") or "") if ch.isdigit())
    sufijo = (f"{periodo['anio']}-S{periodo['semestre']}" if periodo["periodicidad"] == "semestral"
              else f"{periodo['anio']}{str(periodo['mes']).zfill(2)}")
    return {
        "clase": "declaracion",
        "tipo": tipo,
        "grupo": GRUPO[tipo],
        "obligacion": obligacion,
        "periodo": periodo,
        "contribuyente": {"identificacion": ruc, "nombre": c.get("nombre") or ""},
        "archivo": {
            "nombre": f"Declaracion_{tipo}_{ruc}_{sufijo}.json",
            "contenido": {"detallesDeclaracion": detalles},
        },
        "casilleros": casilleros,
        "calculados_por_el_sri": calculados,
        "no_trasladados": no_trasladados,
        "url": URL_FORMULARIO.format(g=GRUPO[tipo], t=_TITULO_URL[tipo]),
    }
