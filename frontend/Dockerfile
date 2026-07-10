# ── Tributos Web · frontend (Vite/React) · imagen para Coolify ──────────────

# 1) Build
FROM node:20-alpine AS builder
WORKDIR /app

# IMPORTANTE: las variables VITE_* se incrustan en el bundle en build-time.
# En Coolify hay que declararlas como "Build Variable" para que lleguen a estos ARG.
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
# URL del Sistema MAP (contabilidad) para el botón de enlace cruzado / SSO.
# Opcional: si no se define, el botón "Sistema MAP" no aparece.
ARG VITE_MAP_URL
ENV VITE_MAP_URL=${VITE_MAP_URL}

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2) Runtime — estático servido por nginx
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
