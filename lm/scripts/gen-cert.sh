#!/bin/bash
set -e
source /opt/lm/env/.env

CERT_DIR="/opt/lm/certs"
mkdir -p "$CERT_DIR"

openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "$CERT_DIR/traefik.key" \
  -out "$CERT_DIR/traefik.crt" \
  -subj "/CN=${LM_FQDN}" \
  -addext "subjectAltName=DNS:${LM_FQDN}"

echo "? Certificate created for ${LM_FQDN} in ${CERT_DIR}"
