# Despliegue a la web (Render + Supabase)

Arquitectura: **Frontend** (React/Vite, sitio estático) · **Backend** (FastAPI) · **Base de datos/Auth** (Supabase, ya en la nube).

---

## 0. Requisitos previos
- Cuenta en **GitHub**, **Render** (render.com) y el proyecto **Supabase** ya creado (`iaxhryjsmapwpjbsnavy`).
- El repositorio subido a GitHub (ver más abajo si aún no está).

## 1. Subir el código a GitHub
```bash
git remote -v                      # verifica el remoto
git push -u origin main            # sube todos los commits
```
> Si el push da 403, el token está vencido. Ejecuta `gh auth login` (o crea un token nuevo en GitHub → Settings → Developer settings → Personal access tokens) y reintenta. **Rota el token viejo** que estaba en `.git/config`.

## 2. Desplegar con el Blueprint (render.yaml)
1. En Render: **New → Blueprint** y elige este repositorio. Render lee `render.yaml` y crea **dos servicios**: `tributos-api` (backend) y `tributos-web` (frontend).
2. Te pedirá completar las variables marcadas como *sync:false*. Cárgalas (ver paso 3).
3. **Apply**. Render construye y publica ambos.

> Orden recomendado: deja que cree ambos, anota las URLs (`https://tributos-api.onrender.com` y `https://tributos-web.onrender.com`) y luego ajusta las variables que dependen de esas URLs (CORS_ORIGINS, FRONTEND_URL, VITE_API_URL) y vuelve a desplegar.

## 3. Variables de entorno

### Backend (`tributos-api`)
| Variable | Valor |
|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Settings → API → **service_role** (secreta) |
| `SUPABASE_ANON_KEY` | Settings → API → anon/public |
| `JWT_SECRET` | Settings → API → JWT Secret |
| `ENVIRONMENT` | `production` |
| `CORS_ORIGINS` | URL del frontend, ej. `https://tributos-web.onrender.com` |
| `FRONTEND_URL` | igual que arriba (para el enlace de recuperación de clave) |

### Frontend (`tributos-web`)
| Variable | Valor |
|---|---|
| `VITE_API_URL` | URL del backend, ej. `https://tributos-api.onrender.com` |

> `VITE_API_URL` se "hornea" en el build: si la cambias, hay que **re-desplegar** el frontend.

## 4. Configurar Supabase (Auth)
En Supabase → **Authentication → URL Configuration**:
- **Site URL**: `https://tributos-web.onrender.com`
- **Redirect URLs**: agrega `https://tributos-web.onrender.com/reset-password`
  (sin esto, el correo de recuperación de contraseña no redirige correctamente).
- (Opcional, recomendado para producción) **Authentication → Email → SMTP**: configura tu propio SMTP; el correo por defecto de Supabase tiene límites de envío.

## 5. Verificación post-deploy
- `https://tributos-api.onrender.com/health` → `{"status":"healthy"}`.
- Abre el frontend → debe mostrar la **landing**; entra con tu cuenta admin.
- Prueba: crear usuario, asignar plan, registrar pago, recuperación de contraseña.

---

## Notas importantes
- **Migraciones de base de datos**: ya están aplicadas en Supabase (carpeta `supabase/migrations`, hasta la 022). No hay que correrlas de nuevo.
- **Plantillas oficiales** (`backend/resources/templates/*.xlsx`): se incluyen en el repo (necesarias para "Declaración oficial").
- **Códigos ICE** (`codigos_ice.xls`, 7 MB): NO se sube al repo. Los 45.654 códigos ya están en la tabla `ice_codigos` (búsqueda funciona). El sistema de archivos de Render es **efímero**, así que "Reemplazar archivo / Actualizar en la base" desde la web no persiste entre despliegues; si necesitas re-importar en producción, conviene mover ese archivo a **Supabase Storage** (pendiente opcional).
- **Plan gratuito de Render**: el backend se "duerme" tras inactividad y la primera petición tarda ~30 s. Para producción real usa un plan pago (sin sleep).
- **Seguridad**: ya activos cabeceras de seguridad, rate-limiting, aislamiento por usuario, control de 3 IPs y HTTPS (lo provee Render). El rate-limit es en memoria (ok para 1 instancia; si escalas, usar Redis).
