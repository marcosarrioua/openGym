#!/bin/sh
# Render entrypoint: render the nginx template, serve the app + proxy /api to node, and
# keep node as PID 1 so the container stops (and Render restarts it) if the API dies.
set -e

# envsubst with an explicit variable list: only these five are substituted, everything
# else in the template ($uri, $host, ...) is nginx runtime syntax and stays untouched.
envsubst '${NGINX_PORT} ${BACKEND} ${PORT} ${RESOLVER} ${CF_CONNECTING_IP}' \
  < /etc/nginx/templates/default.conf.template > /etc/nginx/http.d/default.conf

nginx -g 'daemon off;' &

# server.js reads process.env.PORT; the ambient PORT is Render's public routing port that
# nginx owns, so node gets its own isolated value. exec keeps it as the container's PID 1.
PORT=3000 exec node server.js