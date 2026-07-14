# Verificación end-to-end — Módulo Devolución de IVA (tercera edad / discapacidad)

Checklist para correr en la **máquina de desarrollo con Python** (`mapos`), donde
sí se puede levantar el backend FastAPI. En el equipo `digic` no hay Python, por
eso esta verificación quedó pendiente de ejecutar en la superficie real (backend
HTTP + navegador). La capa de datos ya se validó contra la BD real (proyecto
`tributos`) con un contribuyente que tiene el servicio activo: los cálculos de
tope y `monto = min(IVA, tope)` coincidieron con el router, y las constraints
UNIQUE(client_id, mes, anio) y ON DELETE CASCADE funcionaron.

Ruta del módulo: **`/devoluciones-iva/tercera-edad`**
Gating: usuario con módulo **`declaraciones`** + submódulo **`decl_devoluciones`**
Servicio por cliente: **`devolucion_iva`** (tabla `client_services`)

---

## 0. Prerrequisitos (una vez)

- [ ] **Python + venv funcionando** en `backend/` (el venv de este repo apunta a
      `C:\Users\mapos\…`; si estás en `mapos`, debería resolver).
      ```powershell
      cd backend
      .\venv\Scripts\Activate.ps1
      python --version            # debe imprimir 3.11/3.12, no el stub de Store
      pip install -r requirements.txt
      ```
- [ ] **`backend/.env`** con las claves reales (ver `backend/.env.example`):
      `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (o service role), claves de cifrado de
      credenciales, `CORS_ORIGINS` incluyendo el origen del frontend.
- [ ] **`frontend/.env.local`** con `VITE_API_URL=http://localhost:8000`.
- [ ] **Deps del frontend**: `cd frontend && npm install`.
- [ ] **Migración 031 aplicada** (ya lo está en `tributos`; si usas otra BD, corre
      `backend/migrations/031_devoluciones_iva.sql`).

## 1. Datos de prueba (una vez)

- [ ] **Usuario de prueba** con módulo `declaraciones` y submódulo
      `decl_devoluciones`. Si falta, otórgalo por el panel Admin (Permisos/Módulos)
      o por SQL:
      ```sql
      -- comprobar
      select * from user_modules where user_id = '<UID>';
      select * from user_submodules where user_id = '<UID>';
      ```
- [ ] **Contribuyente con el servicio `devolucion_iva`** activo y **facturas en su
      período**. Para activar el servicio en un cliente: **Admin → Credenciales SRI
      → casilla "Devolución IVA"** (escribe en `client_services`, service
      `devolucion_iva`). Para elegir uno con datos:
      ```sql
      select cs.client_id, count(i.*) as facturas
        from client_services cs
        left join invoices i on i.client_id = cs.client_id
       where cs.service = 'devolucion_iva'
       group by cs.client_id order by facturas desc;
      ```
      Toma el `client_id` con más facturas y úsalo abajo como `<CLIENT_ID>`.

## 2. Levantar la app

- [ ] Backend: `cd backend && uvicorn main:app --reload --port 8000`
      → abre `http://localhost:8000/docs` y confirma que aparece el tag
      **`devoluciones-iva`** con sus rutas (comprobantes, parametros, solicitudes…).
- [ ] Frontend: `cd frontend && npm run dev` → abre la URL que imprime Vite.
- [ ] Login con el usuario de prueba.

## 3. Flujo feliz (GUI) — la parte que confirma "funciona en la app"

- [ ] En el sidebar aparece **👵 Devolución IVA** (solo si el usuario tiene el
      submódulo). Entra a **Tercera edad** → ruta `/devoluciones-iva/tercera-edad`.
- [ ] Sin cliente seleccionado, se muestra la **pantalla de selección** con los
      contribuyentes que tienen `devolucion_iva`. Si el usuario NO tiene el
      submódulo, la ruta debe bloquearse (RequireSubmodule).
- [ ] Selecciona el contribuyente de prueba. Debe cargar:
  - [ ] **Período** correcto (el del cliente) y lista de **comprobantes** (base/IVA
        por fila).
  - [ ] **Tope mensual** = `RBU × base_RBU × 0.15`. Tercera edad 2026:
        `482 × 5 × 0.15 = 361.50`. (RBU: 2023=450, 2024=460, 2025=470, 2026=482.)
- [ ] **Marca** algunos comprobantes → el resumen recalcula base/IVA/solicitar/
      excedente. Si el IVA total marcado es menor al tope, `solicitar = IVA` y
      excedente 0; si lo supera, `solicitar = tope`.
- [ ] **Guardar** → mensaje "Solicitud guardada: $X a solicitar."
- [ ] La solicitud aparece en el **historial** con estado **📝 Borrador**.
- [ ] **Exportar Excel** → descarga `DevolucionIVA_<ident>_2026-05.xlsx`; ábrelo:
      cabecera (contribuyente, período, beneficiario), grilla de ítems con clave de
      acceso, y totales + tope + IVA a solicitar al pie.
- [ ] **Cambiar estado** a Presentada / Aprobada / Rechazada → el historial refleja
      el nuevo estado.
- [ ] **Eliminar** la solicitud → desaparece del historial (y borra sus ítems).

## 4. Probes adversariales (romper a propósito)

- [ ] **Discapacidad**: cambia tipo a *discapacidad*, deja porcentaje vacío →
      Guardar debe fallar con "indica el porcentaje (30 a 100)".
- [ ] **Discapacidad con %**: pon 85% → tope = `482 × 2 × 0.15 × 1.0 = 144.60`.
      Con 40% → proporción 0.6 → `144.60 × 0.6 = 86.76`. Verifica que `solicitar`
      respeta el tope proporcional. (Proporciones: ≥85→1.0, ≥75→0.8, ≥50→0.7,
      ≥40→0.6, ≥30→0.5.)
- [ ] **Excedente**: elige un contribuyente/período cuyo IVA marcado **supere** el
      tope → el mensaje debe avisar "supera el tope en $X; se solicita el tope" y
      `monto = tope`.
- [ ] **Sin comprobantes marcados** → Guardar avisa "Marca al menos un comprobante".
- [ ] **Reemplazo (UNIQUE client+mes+anio)**: guarda, cambia la selección, guarda de
      nuevo → debe **reemplazar** la solicitud del período (no duplicar). Confirma en
      BD que sigue habiendo 1 sola solicitud para ese `client_id/mes/anio`.
- [ ] **Snapshot inmutable**: guarda una solicitud, luego borra/edita una de las
      facturas incluidas en `invoices` → el ítem guardado en
      `devoluciones_iva_items` **no** debe cambiar (el snapshot manda).
- [ ] **Aislamiento (tenancy)**: intenta abrir/guardar con un `client_id` que no es
      tuyo (por API directa) → debe dar 403/404 (`assert_client_owner`).
- [ ] **Gating de submódulo**: con un usuario SIN `decl_devoluciones`, entra a la URL
      directa `/devoluciones-iva/tercera-edad` → bloqueado; y `GET
      /api/devoluciones-iva/comprobantes` → 403.

## 5. Alternativa / complemento por API (sin GUI)

Con el backend arriba y un token válido (cópialo de localStorage tras login):

```bash
TOKEN="<jwt>"; API=http://localhost:8000; CID="<CLIENT_ID>"
# Parámetros / tope
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/devoluciones-iva/parametros?anio=2026&tipo=tercera_edad"
# Comprobantes del período
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/devoluciones-iva/comprobantes?client_id=$CID"
# Guardar (usa invoice_ids reales del paso anterior)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"client_id":"'$CID'","tipo_beneficiario":"tercera_edad","invoice_ids":["<id1>","<id2>"]}' \
  "$API/api/devoluciones-iva/solicitudes"
# Historial
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/devoluciones-iva/solicitudes?client_id=$CID"
```
Espera 200 con los montos esperados; 401 sin token; 403 con cliente ajeno.

## 6. Verificación en BD (opcional, confirmar persistencia real)

```sql
select id, mes, anio, tipo_beneficiario, total_iva, tope_mensual, monto_solicitado, estado
  from devoluciones_iva_solicitudes where client_id = '<CLIENT_ID>';
select count(*) from devoluciones_iva_items
  where solicitud_id = (select id from devoluciones_iva_solicitudes
                        where client_id='<CLIENT_ID>' limit 1);
```

## 7. Limpieza

- [ ] Elimina las solicitudes de prueba (desde la GUI, o
      `delete from devoluciones_iva_solicitudes where client_id='…';` — el CASCADE
      borra los ítems).
- [ ] Si activaste el servicio o el submódulo solo para probar y no deben quedar,
      revíertelos.

---

### Criterio de PASS
Flujo feliz completo (§3) + al menos los probes de discapacidad, excedente y
reemplazo (§4) observados en la app real, con la solicitud persistida y luego
limpiada. Captura el Excel exportado y una pantalla del historial como evidencia.
