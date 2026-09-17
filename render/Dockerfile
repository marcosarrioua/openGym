# openGym on Render — ONE service, ONE origin (required for WebAuthn / passkeys).
#
# nginx serves the built frontend and proxies /api to a node server.js inside the
# same container, so the browser talks to a single https origin. User data lives on a
# Render persistent disk mounted at /data (DATA_DIR). Exercise images/GIFs are pulled
# from the jsDelivr dataset at build time (ARG VITE_IMG_BASE / VITE_GIF_BASE — Render
# passes service env vars through as build args automatically), so nothing ~140 MB is
# shipped into the image or served from Render.
#
# This is a deployment recipe only: it reuses api/, frontend/ and web/ unmodified.

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
# --ignore-scripts: @capacitor/assets -> sharp (libvips download) is only needed for app icons.
RUN npm ci --ignore-scripts
# The Coach's runtime-neutral core sits in api/coach/core and is imported from frontend/src
# as ../../../api/coach/core/*, so it must keep its repository-relative position (see web/Dockerfile).
COPY api/coach/core/ /app/api/coach/core/
COPY frontend/ ./
ARG VITE_IMG_BASE=https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/
ARG VITE_GIF_BASE=https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/videos/
ENV VITE_IMG_BASE=$VITE_IMG_BASE VITE_GIF_BASE=$VITE_GIF_BASE
RUN npm run build

FROM node:22-alpine
RUN apk upgrade --no-cache && apk add --no-cache nginx gettext
# Same unprivileged user Coach jobs drop to as in api/Dockerfile; canDropPrivileges() fails
# closed on Linux without it.
RUN adduser -D -H -s /sbin/nologin coach

WORKDIR /app/api
COPY api/package.json api/package-lock.json* ./
# Coach's optional runtime (the Claude Agent SDK) is deliberately not installed: it stays inert.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY api/server.js api/push-messages.js api/verify-error.js api/remote-store.js ./
COPY api/coach ./coach

COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY render/run.sh /app/run.sh

ENV NODE_ENV=production
# nginx takes the public port (Render routes traffic to PORT, 10000 by default) and proxies
# /api to the node process on 127.0.0.1:3000. BACKEND is an IP literal, so the template's
# resolver is never actually queried.
ENV BACKEND=127.0.0.1
ENV PORT=3000
ENV NGINX_PORT=10000
ENV RESOLVER=127.0.0.11
ENV CF_CONNECTING_IP=""

CMD ["/bin/sh", "/app/run.sh"]