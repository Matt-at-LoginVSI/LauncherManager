#!/bin/bash
set -euo pipefail

export DISPLAY=:99

echo "[xfreerdp] ==============================================="
echo "[xfreerdp] Starting xfreerdp subsystem (Xvfb + Openbox)"
echo "[xfreerdp] DISPLAY=${DISPLAY}"
echo "[xfreerdp] ==============================================="

###############################################
# 0. Signal Handling (clean shutdown)
###############################################
cleanup() {
    echo "[xfreerdp] Caught shutdown signal. Cleaning up..."
    pkill -TERM Xvfb 2>/dev/null || true
    pkill -TERM openbox 2>/dev/null || true
    rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 || true
    echo "[xfreerdp] Shutdown complete."
    exit 0
}

trap cleanup SIGTERM SIGINT


###############################################
# 1. Remove stale lock files + kill old servers
###############################################
echo "[xfreerdp] Cleaning stale X11 locks..."
rm -f /tmp/.X99-lock || true
rm -f /tmp/.X11-unix/X99 || true

# Ensure directory exists with correct permissions
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# Kill any leftover X servers if the container was restarted
pkill -TERM Xvfb 2>/dev/null || true
pkill -TERM openbox 2>/dev/null || true
sleep 0.5


###############################################
# 2. Start Xvfb safely
###############################################
echo "[xfreerdp] Starting Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp > /var/log/xvfb.log 2>&1 &

sleep 1

if ! pgrep Xvfb >/dev/null; then
    echo "[xfreerdp] ERROR: Xvfb failed to start!"
    echo "======= Xvfb Log Output ======="
    cat /var/log/xvfb.log || true
    echo "================================"
    exit 1
fi

echo "[xfreerdp] Xvfb is running."


###############################################
# 3. Start Openbox (lightweight WM)
###############################################
echo "[xfreerdp] Starting Openbox..."
openbox > /var/log/openbox.log 2>&1 &

sleep 1

if ! pgrep openbox >/dev/null; then
    echo "[xfreerdp] ERROR: Openbox failed to start!"
    echo "======= Openbox Log Output ======="
    cat /var/log/openbox.log || true
    echo "=================================="
    exit 1
fi

echo "[xfreerdp] Openbox is running."


###############################################
# 4. Verify X11 is healthy
###############################################
echo "[xfreerdp] Checking X11 with xdpyinfo..."
if ! xdpyinfo >/dev/null 2>&1; then
    echo "[xfreerdp] ERROR: X11 server is not responding."
    xdpyinfo 2>&1 || true
    exit 1
fi

echo "[xfreerdp] X11 environment verified OK."


###############################################
# 5. Watchdog — restarts Xvfb if it crashes
###############################################
(
    while true; do
        if ! pgrep Xvfb >/dev/null; then
            echo "[xfreerdp] WARNING: Xvfb crashed! Restarting..."
            rm -f /tmp/.X99-lock || true
            Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp > /var/log/xvfb.log 2>&1 &
        fi
        sleep 2
    done
) &


###############################################
# 6. Execute passed commands or fallback
###############################################
echo "[xfreerdp] Runtime environment is READY."
echo "[xfreerdp] Command to run: $*"

if [[ $# -eq 0 ]]; then
    echo "[xfreerdp] No command provided ? entering sleep mode."
    exec bash -c "sleep infinity"
else
    exec "$@"
fi
