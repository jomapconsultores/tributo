# Gestor SRI Web

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
