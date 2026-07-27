# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba del lector de facturas de licor en PDF (RIDE) — services/pdf_parser_ice.

No toca la BD ni necesita el backend levantado:

    ./backend/venv/Scripts/python.exe scripts/test_pdf_ice.py

La muestra de abajo es el texto que PyPDF2 saca de un RIDE real, con el
contribuyente cambiado. Reproduce las dos trampas del formato:
  · las columnas salen PEGADAS ('31.20786213527' = total 31.20 + código 786213527,
    '01392.60' = código 0139 + precio unitario 2.60);
  · la descripción trae números que NO son columnas ('15V', '750ML', '(12U)') y que
    hay que conservar, porque de ahí salen el grado y el volumen para el ICE.
La verificación de fondo es la del propio parser: las líneas tienen que sumar el
subtotal impreso; si no, no se carga nada.

Con --dir se corre además contra PDFs de verdad (no se guardan en el repo):

    ./backend/venv/Scripts/python.exe scripts/test_pdf_ice.py --dir ~/Downloads
"""
import argparse
import glob
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from services import pdf_parser_ice as P  # noqa: E402

_ok = _fail = 0


def check(nombre, cond, detalle=""):
    global _ok, _fail
    if cond:
        _ok += 1
        print(f"  PASS  {nombre} {detalle}")
    else:
        _fail += 1
        print(f"  FALLA {nombre} {detalle}")
    return bool(cond)


RIDE = """R.U.C.:
FACTURA
NUMERO DE AUTORIZACION
CLAVE DE ACCESO
OBLIGADO A LLEVAR CONTABILIDAD0206202601115014209700120010110000000060000000012
02/06/2026 23:52:08
NORMAL1150142097001
DISTRIBUIDORA DE PRUEBA S.A.
Razon Social / Nombres y Apellidos:
Identificacion
Fecha GuiaCOMERCIAL EJEMPLO S.C.C.
1799999999001
02/06/2026001-100-000000753No.
Cod.
PrincipalCantidad SubsidioPrecio TotalDescripcionCod.
AuxiliarDescuento Detalle AdicionalPrecio sin
SubsidioPrecio Unitario
31.20786213527
01392.60 0.00PACK VODKA SECO GLACIAL
15V 750ML (1U)+
AGUARDIENTE DE CANA 15V
375 ML (1U)12.00 0.00 0.00
254.10000000000
00528.47 0.00CAJA COCKTAIL CON VODKA
SABOR A MARACUYA 5V
800ML (12U) CORP30.00 0.00 0.00
115.80 006868 5.79 0.00CAJA COCKTAIL CON BAJO
GRADO ALCOHOLICO SABOR
A DURAZNO 5V 800ML (12U)20.00 0.00 0.00
Informacion Adicional
Forma de pago Valor
01 - SIN UTILIZACION DEL SISTEMA FINANCIERO 690.72602.36 SUBTOTAL 15%
0.00 SUBTOTAL NO OBJETO DE IVA
0.00 SUBTOTAL EXENTO DE IVA
401.10 SUBTOTAL SIN IMPUESTOS
0.00 TOTAL DESCUENTO
201.26 ICE
90.35 IVA 15%
0.00 IRBPNR
0.00 PROPINA
690.72 VALOR TOTAL
"""


def con_muestra():
    print("=== 1. RIDE de muestra (columnas pegadas y números en la descripción) ===")
    original = P._texto_pdf
    P._texto_pdf = lambda _b: RIDE
    try:
        regs = P.parse_ice_pdf(b"%PDF-falso")
    finally:
        P._texto_pdf = original

    if not check("lee las tres líneas del detalle", len(regs) == 3, f"leyó {len(regs)}"):
        return
    cant = [r["cantidad_cajas"] for r in regs]
    punit = [r["precio_unitario"] for r in regs]
    tot = [r["precio_total_sin_impuesto"] for r in regs]
    check("cantidades correctas", cant == [12.0, 30.0, 20.0], cant)
    check("precios unitarios correctos (no confunde el código pegado)",
          punit == [2.6, 8.47, 5.79], punit)
    check("precios totales correctos", tot == [31.2, 254.1, 115.8], tot)
    check("las líneas suman el subtotal impreso", round(sum(tot), 2) == 401.10, sum(tot))

    ice = [r["valor_ice"] for r in regs]
    check("el ICE repartido suma el del comprobante", round(sum(ice), 2) == 201.26, ice)
    check("el ICE se reparte por peso del precio",
          ice[1] > ice[2] > ice[0], ice)

    check("conserva grado y volumen en la descripción (los usa el cálculo ICE)",
          "15V" in regs[0]["nombre_producto"] and "750ML" in regs[0]["nombre_producto"],
          regs[0]["nombre_producto"])
    check("saca el grado del nombre", regs[0]["grado_alcoholico"] in ("15", 15, "15V"),
          regs[0]["grado_alcoholico"])
    check("marca el origen para poder revisarlas", all(r["origen"] == "pdf" for r in regs))
    check("toma la clave de acceso del comprobante",
          regs[0]["unique_id"].startswith("02062026011150142097001200101100000000600000000"),
          regs[0]["unique_id"])
    check("fecha del comprobante", regs[0]["fecha"] == "02/06/2026", regs[0]["fecha"])
    check("comprador del comprobante", regs[0]["id_cliente"] == "1799999999001",
          regs[0]["id_cliente"] + " / " + regs[0]["razon_social_cliente"])
    check("las líneas de un mismo comprobante no se pisan",
          len({r["unique_id"] for r in regs}) == 3)

    print("=== 2. si el texto no cuadra, NO se carga nada ===")
    roto = RIDE.replace("254.10000000000", "999.99000000000")
    P._texto_pdf = lambda _b: roto
    try:
        check("descarta el comprobante cuyas líneas no dan el subtotal",
              P.parse_ice_pdf(b"%PDF-falso") == [])
    finally:
        P._texto_pdf = original


def con_pdfs_reales(carpeta):
    print(f"=== 3. PDFs reales de {carpeta} ===")
    archivos = sorted(glob.glob(os.path.join(os.path.expanduser(carpeta), "*.pdf")))
    if not archivos:
        print("  (no hay PDFs en esa carpeta)")
        return
    con_ice = leidas = 0
    for f in archivos:
        try:
            raw = open(f, "rb").read()
            texto = P._texto_pdf(raw)
        except Exception:
            continue
        if P._total_etiqueta(texto, r"ICE\b") <= 0:
            continue
        con_ice += 1
        regs = P.parse_ice_pdf(raw)
        if not regs:
            print(f"  NO SE LEYÓ  {os.path.basename(f)}")
            continue
        leidas += 1
        sub = P._total_etiqueta(texto, r"SUBTOTAL\s+SIN\s+IMPUESTOS")
        ice = P._total_etiqueta(texto, r"ICE\b")
        cuadra = (round(sum(r["precio_total_sin_impuesto"] for r in regs), 2) == sub
                  and round(sum(r["valor_ice"] for r in regs), 2) == ice)
        check(f"{os.path.basename(f)} ({len(regs)} líneas) cuadra con el RIDE", cuadra)
    print(f"  facturas con ICE: {con_ice} · leídas: {leidas}")


def main():
    ap = argparse.ArgumentParser(description="Prueba del lector de RIDE con ICE")
    ap.add_argument("--dir", help="carpeta con PDFs reales para probar también")
    args = ap.parse_args()
    con_muestra()
    if args.dir:
        con_pdfs_reales(args.dir)
    print(f"\n===== RESULTADO: {_ok} PASS / {_fail} FALLA =====")
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
