#!/usr/bin/env bash
set -euo pipefail

########################################
# 1. Validate Inputs
########################################
MACHINE_NAME="${RD_OPTION_MACHINENAME:-}"
LM_RUN_ID="${RD_OPTION_LMRUNID:-}"

if [[ -z "$MACHINE_NAME" || -z "$LM_RUN_ID" ]]; then
  echo "ERROR: machineName and lmRunId are required."
  exit 1
fi

echo "[Start] Starting Login Enterprise Launcher for ${MACHINE_NAME} (Run ${LM_RUN_ID})"

########################################
# 2. Resolve Launcher SSH Context
########################################
echo "[Start] Resolving from LM-API..."

CONTEXT_JSON=$(curl -s "http://lm-api:8080/api/automation/resolve/${MACHINE_NAME}")
if [[ -z "$CONTEXT_JSON" || "$CONTEXT_JSON" == "null" ]]; then
  echo "ERROR: LM-API returned null/empty."
  exit 1
fi

SSH_HOST=$(echo "$CONTEXT_JSON" | jq -r '.ssh.host')
SSH_PORT=$(echo "$CONTEXT_JSON" | jq -r '.ssh.port // 22')
SSH_USER=$(echo "$CONTEXT_JSON" | jq -r '.ssh.username')
SSH_PASS=$(echo "$CONTEXT_JSON" | jq -r '.ssh.secret')

if [[ -z "$SSH_HOST" || -z "$SSH_USER" || -z "$SSH_PASS" ]]; then
  echo "ERROR: LM-API resolve did not return required SSH fields."
  exit 1
fi

echo "[Start] Launcher SSH → ${SSH_USER}@${SSH_HOST}:${SSH_PORT}"

########################################
# 3. Check SSH Connectivity
########################################
echo "[Start] Testing SSH connectivity..."
if ! sshpass -p "$SSH_PASS" ssh \
      -o StrictHostKeyChecking=no \
      -o ConnectTimeout=10 \
      -p "$SSH_PORT" \
      "$SSH_USER@$SSH_HOST" "hostname" >/dev/null 2>&1; then
  echo "ERROR: SSH connectivity failed."
  exit 1
fi
echo "[Start] SSH connectivity OK."

########################################
# 4. Stop Existing Launcher Instances (Crash-Proof)
########################################
echo "[Stop] Killing any existing instances..."

STOP_SCRIPT=$(cat << 'EOF'
$ErrorActionPreference = 'SilentlyContinue'
$launcher = "LoginEnterprise.Launcher.UI"
$uwc = "UniversalWebConnector"

Write-Output "[Stop] Terminating processes..."

# FIX: Added -ErrorAction SilentlyContinue to Get-Process so it doesn't crash if nothing is found
Get-Process -Name $launcher -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name $uwc      -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

# Verification
if (Get-Process -Name $launcher -ErrorAction SilentlyContinue) {
    # Last ditch effort: TaskKill
    Write-Warning "[Stop] Process stubborn. Attempting TaskKill..."
    cmd.exe /c "taskkill /F /IM LoginEnterprise.Launcher.UI.exe /T >NUL 2>&1"
    Start-Sleep -Seconds 1
}

if (Get-Process -Name $launcher -ErrorAction SilentlyContinue) {
    Write-Error "[Stop] FAILED: Launcher UI is still running."
    exit 1
}

Write-Output "[Stop] Clean slate confirmed."
exit 0
EOF
)

echo "$STOP_SCRIPT" | sshpass -p "$SSH_PASS" ssh \
  -o StrictHostKeyChecking=no \
  -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "powershell -NoProfile -Command -"

if [[ $? -ne 0 ]]; then
    echo "ERROR: Failed to clean up existing processes."
    exit 1
fi

########################################
# 5. Ensure lm-xfreerdp container is running
########################################
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI not available inside Rundeck container."
  exit 1
fi

echo "[Start] Ensuring lm-xfreerdp container is running..."
if docker ps --format '{{.Names}}' | grep -qx 'lm-xfreerdp'; then
  echo "[Start] lm-xfreerdp already running."
else
  if docker ps -a --format '{{.Names}}' | grep -qx 'lm-xfreerdp'; then
    echo "[Start] lm-xfreerdp exists but stopped — starting..."
    docker start lm-xfreerdp >/dev/null 2>&1
  else
    echo "[Start] lm-xfreerdp not found — creating new container..."
    docker run -d \
          --name lm-xfreerdp \
          --network host \
          le-mgr/xfreerdp:latest >/dev/null 2>&1
  fi
fi

########################################
# 6. Build RDP credentials
########################################
RDP_USER="$SSH_USER"
RDP_DOMAIN=""

if [[ "$SSH_USER" == *"\\"* ]]; then
  RDP_DOMAIN="${SSH_USER%%\\*}"
  RDP_USER="${SSH_USER##*\\}"
elif [[ "$SSH_USER" == *"@"* ]]; then
  RDP_USER="${SSH_USER%@*}"
  DOMAIN_FQDN="${SSH_USER#*@}"
  RDP_DOMAIN="${DOMAIN_FQDN%%.*}"
fi

########################################
# 7. Start RDP Session via xfreerdp
########################################
XFREE_LOG="/tmp/xfreerdp-start-${MACHINE_NAME}.log"
echo "[Start] Starting RDP session via xfreerdp..."

XFREE_ARGS=(
  "/v:${SSH_HOST}"
  "/u:${RDP_USER}"
  "/p:${SSH_PASS}"
  "/cert-ignore"
  "/relax-order-checks"
  "+offscreen-cache"
  "/auto-reconnect"
  "/auto-reconnect-max-retries:5"
  "/dynamic-resolution"
  "/log-level:INFO"
)

if [[ -n "$RDP_DOMAIN" ]]; then
  XFREE_ARGS+=("/d:${RDP_DOMAIN}")
fi

docker exec -e DISPLAY=:99 lm-xfreerdp \
  xfreerdp "${XFREE_ARGS[@]}" \
  >"${XFREE_LOG}" 2>&1 &

echo "[Start] xfreerdp started (background)."

########################################
# 8. Wait for Active session
########################################
echo "[Start] Waiting for an Active session for user '${RDP_USER}'..."

SESSION_ID=""
ATTEMPTS=25

for i in $(seq 1 "${ATTEMPTS}"); do
  SESSION_INFO=$(sshpass -p "$SSH_PASS" ssh \
    -o StrictHostKeyChecking=no \
    -p "$SSH_PORT" \
    "$SSH_USER@$SSH_HOST" "qwinsta" 2>/dev/null || true)

  SESSION_ID=$(echo "$SESSION_INFO" | awk -v user="$RDP_USER" '
    NR > 1 && $2 == user && $4 ~ /Active/ { print $3; exit }
  ' | tr -d '\r')

  if [[ -n "$SESSION_ID" ]]; then
    echo "[Start] Detected Active session for ${RDP_USER} with ID ${SESSION_ID} (attempt ${i}/${ATTEMPTS})"
    break
  fi
  sleep 2
done

if [[ -z "$SESSION_ID" ]]; then
  echo "[Start] ERROR: No Active session detected."
  tail -n 20 "${XFREE_LOG}" 2>/dev/null || true
  exit 1
fi

########################################
# 9. Smart Start: Wait for Startup vs Inject
########################################
echo "[Start] Session Active. Verifying application startup..."

SMART_START_SCRIPT=$(cat << 'EOF'
$launcherPath = "C:\Program Files\Login VSI\Login Enterprise Launcher\LoginEnterprise.Launcher.UI.exe"
$procName = "LoginEnterprise.Launcher.UI"
$maxWaitSeconds = 15

Write-Output "[SmartStart] Waiting for Windows Startup Shortcut to fire..."

# 1. Wait Loop (Check if Startup folder worked)
for ($i = 0; $i -lt $maxWaitSeconds; $i++) {
    $p = Get-Process -Name $procName -ErrorAction SilentlyContinue
    if ($p) {
        Write-Output "[SmartStart] SUCCESS: App started automatically (PID: $($p.Id))."
        exit 0
    }
    Start-Sleep -Seconds 1
}

# 2. Force Start (If waiting failed)
Write-Warning "[SmartStart] Startup shortcut timed out. Forcing start now..."

if (-not (Test-Path $launcherPath)) {
    Write-Error "[SmartStart] Launcher EXE not found at expected path."
    exit 1
}

$taskName = "StartLoginLauncher_Force"
$action = New-ScheduledTaskAction -Execute $launcherPath -WorkingDirectory (Split-Path $launcherPath -Parent)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# 3. Final Verification
if (Get-Process -Name $procName -ErrorAction SilentlyContinue) {
    Write-Output "[SmartStart] SUCCESS: App force-started successfully."
    exit 0
} else {
    Write-Error "[SmartStart] FAILED: App did not start."
    exit 1
}
EOF
)

echo "$SMART_START_SCRIPT" | sshpass -p "$SSH_PASS" ssh \
  -o StrictHostKeyChecking=no \
  -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "powershell -NoProfile -Command -"

########################################
# 10. Transfer session to Console
########################################
echo "[Start] Transferring Session ${SESSION_ID} to physical console (tscon)..."

sshpass -p "$SSH_PASS" ssh \
  -o StrictHostKeyChecking=no \
  -p "$SSH_PORT" \
  "$SSH_USER@$SSH_HOST" "tscon ${SESSION_ID} /dest:console"

########################################
# 11. Mark RUNNING in LM-API
########################################
curl -s -X POST "http://lm-api:8080/api/launchers/${MACHINE_NAME}/state" \
  -H "Content-Type: application/json" \
  -d "{\"state\": \"running\"}" >/dev/null || true

########################################
# 12. Record automation run
########################################
curl -s -X POST "http://lm-api:8080/api/automation/runs" \
  -H "Content-Type: application/json" \
  -d "{
    \"machine_name\": \"${MACHINE_NAME}\",
    \"job_name\": \"Start Launcher\",
    \"job_type\": \"start\",
    \"step_name\": \"start-complete\",
    \"status\": \"success\",
    \"result\": { \"started\": true }
  }" >/dev/null || true

echo "[Start] COMPLETE for ${MACHINE_NAME}"
exit 0
