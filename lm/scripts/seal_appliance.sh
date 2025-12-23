#!/bin/bash
set -e

# seal_appliance.sh
# RUN THIS BEFORE EXPORTING THE OVA

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root"
  exit
fi

# --- NEW: Load Environment Variables ---
if [ -f /opt/lm/env/.env ]; then
    set -a
    source /opt/lm/env/.env
    set +a
fi
# ---------------------------------------

echo "========================================================"
echo "   SEALING APPLIANCE FOR EXPORT"
echo "========================================================"
echo "1. Network config will be reset to DHCP"
echo "2. All customer secrets/data will be wiped"
echo "3. Setup Wizard will be enabled on next boot"
echo "========================================================"
read -p "Are you sure? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

echo "[1/5] Stopping Docker Services..."
cd /opt/lm/docker
docker compose down

echo "[2/5] Wiping Database Data (Preserving Schema)..."
# Start Postgres temporarily to truncate tables
docker compose up -d postgres
echo "Waiting for DB..."
sleep 10

# --- FIX: Uses 'launcher_policies' instead of 'policies' ---
docker exec -i lm-postgres psql -U "$PGUSER" -d le_mgr <<EOF
TRUNCATE TABLE automation_runs;
TRUNCATE TABLE launchers CASCADE;
TRUNCATE TABLE credentials CASCADE;
TRUNCATE TABLE launcher_policies CASCADE;
TRUNCATE TABLE launcher_groups CASCADE; 
EOF
# ---------------------------------------

docker compose stop postgres
docker compose rm -f postgres

echo "[3/5] Resetting Secrets & Logs..."
# Wipe n8n env
> /opt/lm/env/n8n.env
# Wipe text files (keep empty files to preserve permissions)
for f in /opt/lm/env/*.txt; do > "$f"; done
# Remove Certificates
rm -f /opt/lm/certs/*.key /opt/lm/certs/*.crt
# Remove Logs
rm -rf /opt/lm/logs/*

echo "[4/5] Resetting Network to DHCP..."
# Get active connection
CONN=$(nmcli -t -f NAME connection show | head -n 1)
if [ -n "$CONN" ]; then
    nmcli con mod "$CONN" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns "" ipv4.dns-search ""
fi

echo "[5/5] Enabling First-Boot Setup..."
touch /opt/lm/env/setup_required
# Ensure admin user can see this file
chmod 755 /opt/lm/env

echo "------------------------------------------------"
echo "Appliance Sealed."
echo "SHUTDOWN NOW via: shutdown -h now"
echo "Then export to OVA."
echo "------------------------------------------------"