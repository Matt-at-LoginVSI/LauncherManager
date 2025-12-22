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

echo "[Stop] Stopping Login Enterprise Launcher for ${MACHINE_NAME} (Run ${LM_RUN_ID})"

########################################
# 2. Resolve Launcher SSH Context
########################################
echo "[Stop] Resolving from LM-API..."

CONTEXT_JSON=$(curl -s "http://lm-api:8080/api/automation/resolve/${MACHINE_NAME}")

if [[ -z "$CONTEXT_JSON" || "$CONTEXT_JSON" == "null" ]]; then
  echo "ERROR: LM-API returned null/empty."
  exit 1
fi

SSH_HOST=$(echo "$CONTEXT_JSON" | jq -r '.ssh.host')
SSH_PORT=$(echo "$CONTEXT_JSON" | jq -r '.ssh.port // 22')
SSH_USER=$(echo "$CONTEXT_JSON" | jq -r '.ssh.username')
SSH_PASS=$(echo "$CONTEXT_JSON" | jq -r '.ssh.secret')

echo "[Stop] Launcher SSH → $SSH_USER@$SSH_HOST:$SSH_PORT"

########################################
# 3. Test SSH Connectivity
########################################
echo "[Stop] Testing SSH connectivity..."

if ! sshpass -p "$SSH_PASS" ssh \
  -o StrictHostKeyChecking=no \
  -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "hostname"; then
    echo "ERROR: SSH connectivity failed."
    exit 1
fi

echo "[Stop] SSH connectivity OK."

########################################
# 4. Stop Launcher UI
########################################
echo "[Stop] Stopping LoginEnterprise.Launcher.UI process..."

sshpass -p "$SSH_PASS" ssh \
  -o StrictHostKeyChecking=no \
  -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" powershell -NoProfile << 'EOF'
Write-Output "[Stop] Checking for LoginEnterprise.Launcher.UI process..."

try {
    $proc = Get-Process -Name "LoginEnterprise.Launcher.UI" -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Output "[Stop] Process found (PID $($proc.Id)) — terminating..."
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } else {
        Write-Output "[Stop] Process already stopped."
    }

    # Double check
    if (Get-Process -Name "LoginEnterprise.Launcher.UI" -ErrorAction SilentlyContinue) {
        Write-Warning "[Stop] Process still running after kill attempt. Proceeding to Logoff anyway."
    }
} catch {
    Write-Warning "[Stop] Unexpected error stopping Launcher UI, continuing to Logoff."
}

exit 0
EOF

echo "[Stop] Launcher UI stop sequence complete."

########################################
# 5. Log off ALL sessions for this user (Fix for Console/Tscon)
########################################
echo "[Stop] Checking for active/console sessions to log off..."

sshpass -p "$SSH_PASS" ssh \
  -o StrictHostKeyChecking=no \
  -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" powershell -NoProfile << 'EOF'
$currentUser = $env:USERNAME
Write-Output "[Stop] Enumerating sessions for user: $currentUser"

# Parse qwinsta output specifically for the current user
# We filter strictly by username to catch 'Console', 'RDP-tcp#', or 'Disc' states
$userSessions = query session | Where-Object { $_ -match "\b$currentUser\b" }

if (-not $userSessions) {
    Write-Output "[Stop] No sessions found for $currentUser."
    exit 0
}

foreach ($line in $userSessions) {
    # Extract the Session ID. 
    # Logic: Split by whitespace. The ID is the first token that is purely an integer.
    $tokens = $line -split '\s+'
    $sessId = $tokens | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1

    if ($sessId) {
        Write-Output "[Stop] Logging off Session ID: $sessId"
        # We use invoke-expression or direct cmd to ensure logoff runs
        cmd.exe /c "logoff $sessId" 2>$null
        Start-Sleep -Seconds 1
    }
}

Write-Output "[Stop] Session cleanup complete."
exit 0
EOF

echo "[Stop] RDP/Console session cleanup complete."

########################################
# 6. Mark launcher as offline in LM-API
########################################
echo "[Stop] Updating launcher state to 'stopped'..."

curl -s -X POST "http://lm-api:8080/api/launchers/${MACHINE_NAME}/state" \
  -H "Content-Type: application/json" \
  -d "{\"state\": \"stopped\"}" >/dev/null || true

echo "[Stop] Launcher state updated."

########################################
# 7. Report Success to LM-API
########################################
echo "[Stop] Reporting success to LM-API..."

curl -s -X POST "http://lm-api:8080/api/automation/runs" \
  -H "Content-Type: application/json" \
  -d "{
    \"machine_name\": \"${MACHINE_NAME}\",
    \"job_name\": \"Stop Launcher\",
    \"job_type\": \"stop\",
    \"step_name\": \"stop-complete\",
    \"status\": \"success\",
    \"result\": {
      \"stopped\": true,
      \"sessionsTerminated\": true
    }
  }" >/dev/null || true

echo "[Stop] COMPLETE for ${MACHINE_NAME}"
exit 0
