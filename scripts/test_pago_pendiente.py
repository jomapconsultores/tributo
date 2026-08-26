# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba del pago que se deja pendiente y vuelve en un mes posterior.

No toca Supabase ni el portal: solo el cálculo de la declaración y la regla que
decide cuánto se traslada. Se puede correr en cualquier momento.

    python scripts/test_pago_pendiente.py

Lo que se comprueba es que el valor no se pierda por el camino:

  · dejarlo pendiente lo saca del total a pagar de HOY;
  · lo que se anota como pendiente es el valor DIFERIDO, no el residual del
    período (que con un diferimiento total es cero);
  · cuando vence, entra en la declaración de ESE mes y se suma a lo que toque;
  · el plazo no es el mismo en los dos impuestos: IVA hasta 3 meses, ICE 1;
  · pedir más de lo permitido se recorta, no se cuela.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

# Credenciales de mentira: config.py las exige para construir Settings, pero esta
# prueba no abre ninguna conexión.
for _var, _val in (("SUPABASE_URL", "http://localhost"), ("SUPABASE_SERVICE_KEY", "x"),
                   ("SUPABASE_ANON_KEY", "x"), ("JWT_SECRET", "x")):
    os.environ.setdefault(_var, _val)

from services.declaracion import declaracion_ice, declaracion_iva   # noqa: E402
from routers.declaraciones import (TOPE_DIFERIMIENTO,               # noqa: E402
                                   _sumar_periodo, monto_que_se_traslada)

fallos = []


def check(cond, que, detalle=""):
    print(("  ok  " if cond else "  FALLA ") + que + (f"  [{detalle}]" if detalle and not cond else ""))
    if not cond:
        fallos.append(que)


def casi(a, b, tol=0.01):
    return abs(float(a) - float(b)) <= tol


# ── Datos mínimos: una venta con IVA y una con ICE ──────────────────────
VENTA_IVA = [{"estado": "OK", "base_15": 1000.0, "iva_15": 150.0}]
VENTA_ICE = [{"estado": "OK", "valor_ice": 100.0, "subtotal": 500.0,
              "producto": "CERVEZA ARTESANAL", "litros": 10, "grado": 5}]

print("\nIVA — hasta tres meses")
hoy = declaracion_iva([], [], VENTA_IVA)
r_hoy = hoy["resumen"]
check(casi(r_hoy["iva_a_pagar"], 150), "sin diferir, se paga el IVA del mes", r_hoy["iva_a_pagar"])

dif = declaracion_iva([], [], VENTA_IVA, diferir_meses=3)
r_dif = dif["resumen"]
check(casi(r_dif["iva_a_pagar"], 0), "diferido, este mes no se paga", r_dif["iva_a_pagar"])
check(casi(r_dif["iva_diferido_actual"], 150), "y queda anotado el valor entero", r_dif["iva_diferido_actual"])
check(casi(monto_que_se_traslada(r_dif), 150),
      "lo que se traslada es el diferido, no el residual del período",
      f"traslada {monto_que_se_traslada(r_dif)} con total_a_pagar={r_dif['total_a_pagar']}")

vence = declaracion_iva([], [], [], pagos_aplazados_vencen_este_periodo=[{"monto": 150.0}])
r_ven = vence["resumen"]
check(casi(r_ven["iva_a_pagar"], 150), "al vencer entra en la declaración de ese mes", r_ven["iva_a_pagar"])
check(any(f["codigo"] == "480" for f in vence["filas"]), "y se ve en el casillero 480")

# Un mes con IVA propio ADEMÁS del que vuelve: se suman, no se pisan.
mixto = declaracion_iva([], [], VENTA_IVA, pagos_aplazados_vencen_este_periodo=[{"monto": 150.0}])
check(casi(mixto["resumen"]["iva_a_pagar"], 300),
      "lo que vence se suma a lo del mes, no lo reemplaza", mixto["resumen"]["iva_a_pagar"])

print("\nICE — un mes, y solo uno")
ice_hoy = declaracion_ice(VENTA_ICE, 2026)
check(casi(ice_hoy["resumen"]["total_a_pagar"], 100), "sin diferir, se paga el ICE del mes",
      ice_hoy["resumen"]["total_a_pagar"])

ice_dif = declaracion_ice(VENTA_ICE, 2026, diferir_meses=1)
r_ice = ice_dif["resumen"]
check(casi(r_ice["total_a_pagar"], 0), "diferido, este mes no se paga", r_ice["total_a_pagar"])
check(casi(r_ice["ice_diferido_actual"], 100), "y queda anotado el ICE neto", r_ice["ice_diferido_actual"])
check(casi(monto_que_se_traslada(r_ice), 100), "que es lo que se traslada", monto_que_se_traslada(r_ice))
check(any(f["codigo"] == "DIF" for f in ice_dif["filas"]), "y se ve como línea aparte del formulario")

ice_ven = declaracion_ice(VENTA_ICE, 2026, pagos_aplazados_vencen_este_periodo=[{"monto": 100.0}])
check(casi(ice_ven["resumen"]["total_a_pagar"], 200),
      "al vencer se suma al ICE del mes en que cae", ice_ven["resumen"]["total_a_pagar"])

ice_tope = declaracion_ice(VENTA_ICE, 2026, diferir_meses=3)
check(ice_tope["resumen"]["diferir_meses"] == 1, "pedir tres meses en ICE se recorta a uno",
      ice_tope["resumen"]["diferir_meses"])

print("\nPlazos y vencimiento")
check(TOPE_DIFERIMIENTO.get("IVA") == 3, "el IVA admite hasta tres meses")
check(TOPE_DIFERIMIENTO.get("ICE") == 1, "el ICE, uno solo")
check(TOPE_DIFERIMIENTO.get("103", 0) == 0, "el 103 no admite dejar el pago pendiente")
check(_sumar_periodo(11, 2026, 3) == (2, 2027), "el vencimiento cruza el año bien",
      str(_sumar_periodo(11, 2026, 3)))
check(_sumar_periodo(12, 2026, 1) == (1, 2027), "diciembre + 1 = enero del año siguiente",
      str(_sumar_periodo(12, 2026, 1)))

print("\nRespaldo para declaraciones viejas")
check(casi(monto_que_se_traslada({"total_a_pagar": 80}), 80),
      "una declaración guardada sin el desglose usa su total a pagar")
check(casi(monto_que_se_traslada({}), 0), "y una sin nada no traslada nada")

print("\n" + ("TODO CORRECTO." if not fallos else f"{len(fallos)} FALLAS: " + "; ".join(fallos)) + "\n")
sys.exit(1 if fallos else 0)
