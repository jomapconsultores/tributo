# Gestor Tributario Web

Plataforma web para procesar, clasificar y exportar facturas del SRI (Servicio de Rentas Internas) de Ecuador.

## Arquitectura

- **Backend**: FastAPI + Python
- **Frontend**: React + Vite
- **Base de datos**: Supabase (PostgreSQL)
- **Hosting**: Coolify

## Setup Local

### Prerequisites
- Python 3.10+
- Node.js 18+
- Git

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Supabase

1. Crear proyecto en https://supabase.com
2. Ejecutar migraciones en `supabase/migrations/`
3. Configurar variables de entorno

## Deployment

Repositorio GitHub conectado a Coolify (dos apps: `tributo` = frontend, `tributos-api` = backend), rama `main`.

- **Auto-deploy:** al hacer push a `main`, Coolify debería reconstruir ambas apps
  automáticamente. Si un push no dispara el deploy, verificar en GitHub → Settings →
  GitHub Apps → Coolify → Advanced → *Recent Deliveries* (entregas del webhook) y que
  la opción *Automatic Deployment* esté activa en cada app de Coolify.
- **Deploy manual (respaldo):** se puede gatillar por la API de Coolify
  (`GET /api/v1/deploy?uuid=<backend>,<frontend>`) y verificar en vivo que el backend
  responde y que `/openapi.json` refleja el código nuevo.
- **Migraciones Supabase:** aplicar las de `supabase/migrations/` ANTES de desplegar el
  código que las usa, para no dejar columnas sin leer entre migración y despliegue.
  `supabase/migrations/` es el ÚNICO lugar donde van: numeradas de corrido y
  aplicadas en ese orden. (Hubo un tiempo una segunda carpeta `backend/migrations/`
  cuya numeración chocaba con esta, así que un despliegue nuevo que siguiera esta
  guía se saltaba cuatro migraciones —entre ellas las tablas de Devolución de IVA—;
  esas cuatro están ahora aquí como 051–054.)
- **Tablas nuevas:** toda tabla se crea con `ENABLE ROW LEVEL SECURITY` y sin
  policies. El backend entra con la service key (salta RLS); el rol `anon` —cuya
  llave es pública, va dentro del bundle del frontend— no debe poder leer ni
  escribir ninguna tabla directamente.

## Autor

Desarrollado por **Marco Antonio Posligua San Martín**.
