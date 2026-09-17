#!/bin/sh
# Render entrypoint: render the nginx template, serve the app + proxy /api to node, and
# keep node as PID 1 so the container stops (and Render restarts it) if the API dies.
set -e

# Render injects its OWN PORT (the public routing port nginx listens on) into every
# service, which would otherwise overwrite the node port in the proxy_pass line and
# turn every /api request into a 502. Force it back to the backend port; node reads
# the same value below, so nginx and node always agree. (API_PORT overrides, default 3000)
export PORT="${API_PORT:-3000}"

# envsubst with an explicit variable list: only these are substituted, everything
# else in the template ($uri, $host, ...) is nginx runtime syntax and stays untouched.
envsubst '${NGINX_PORT} ${BACKEND} ${PORT} ${RESOLVER} ${CF_CONNECTING_IP}' \
  < /etc/nginx/templates/default.conf.template > /etc/nginx/http.d/default.conf

nginx -g 'daemon off;' &

# server.js reads process.env.PORT; exec keeps node as the container's PID 1.
exec node server.js