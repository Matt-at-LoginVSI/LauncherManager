#!/usr/bin/env bash
set -euo pipefail

########################################
# Validate Inputs
########################################
MACHINE_NAME="${RD_OPTION_MACHINENAME:-}"
LM_RUN_ID="${RD_OPTION_LMRUNID:-}"

if [[ -z "$MACHINE_NAME" || -z "$LM_RUN_ID" ]]; then
  echo "ERROR: machineName and lmRunId are required."
  exit 1
fi

echo "[Decommission] Starting decommission for ${MACHINE_NAME} (Run ${LM_RUN_ID})"

########################################
# Resolve Launcher SSH Context
########################################
echo "[Decommission] Calling LM-API resolver..."
CONTEXT_JSON=$(curl -s "http://lm-api:8080/api/automation/resolve/${MACHINE_NAME}")

if [[ -z "$CONTEXT_JSON" || "$CONTEXT_JSON" == "null" ]]; then
  echo "ERROR: LM-API returned null/empty on resolve."
  exit 1
fi

SSH_HOST=$(echo "$CONTEXT_JSON" | jq -r '.ssh.host')
SSH_PORT=$(echo "$CONTEXT_JSON" | jq -r '.ssh.port // 22')
SSH_USER=$(echo "$CONTEXT_JSON" | jq -r '.ssh.username')
SSH_PASS=$(echo "$CONTEXT_JSON" | jq -r '.ssh.secret')

echo "[Decommission] Launcher SSH → $SSH_USER@$SSH_HOST:$SSH_PORT"

########################################
# Test SSH Connectivity
########################################
if ! sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "hostname" >/dev/null 2>&1; then
    echo "ERROR: SSH connectivity failed."
    exit 1
fi

########################################
# 1. STOP PROCESSES & SERVICES
########################################
echo "[Decommission] Stopping processes..."

STOP_SCRIPT=$(cat << 'EOF'
    $ErrorActionPreference = 'SilentlyContinue'
    Write-Output "DEBUG: Attempting to stop applications..."
    
    Stop-Process -Name 'LoginEnterprise.Launcher.UI' -Force
    Stop-Process -Name 'UniversalWebConnector' -Force
    Stop-Process -Name 'msiexec' -Force
    
    Start-Sleep -Seconds 2
    
    cmd.exe /c "taskkill /F /IM LoginEnterprise.Launcher.UI.exe /T >NUL 2>&1"
    cmd.exe /c "taskkill /F /IM UniversalWebConnector.exe /T >NUL 2>&1"
    
    Write-Output "DEBUG: Processes terminated."
    exit 0
EOF
)

echo "$STOP_SCRIPT" | sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" "powershell -NoProfile -Command -"

########################################
# 2. SCORCHED EARTH UNINSTALL (WMI Method)
########################################
echo "[Decommission] Performing Scorched Earth Uninstall (WMI)..."

UNINSTALL_SCRIPT=$(cat << 'EOF'
    $ErrorActionPreference = 'SilentlyContinue'
    
    # We search broadly for "Launcher" and "Universal" to catch any variation of the name
    $searchTerms = @("Login Enterprise Launcher", "Universal Web Connector")
    
    Write-Output "DEBUG: Starting WMI Product Scan (This takes ~30-60 seconds)..."

    foreach ($term in $searchTerms) {
        Write-Output "--- Searching for: $term ---"
        
        # Win32_Product finds ALL MSI-installed software correctly
        $products = Get-WmiObject -Class Win32_Product | Where-Object { $_.Name -like "*$term*" }
        
        if ($products) {
            foreach ($app in $products) {
                Write-Output "FOUND: $($app.Name) (GUID: $($app.IdentifyingNumber))"
                Write-Output "Attempting Uninstall..."
                
                try {
                    $result = $app.Uninstall()
                    if ($result.ReturnValue -eq 0) {
                        Write-Output "SUCCESS: Uninstalled."
                    } else {
                        Write-Error "FAILED: Uninstall return code $($result.ReturnValue)"
                    }
                } catch {
                    Write-Error "EXCEPTION during uninstall: $($_.Exception.Message)"
                }
            }
        } else {
            Write-Output "NOT FOUND: No installed product matched '$term'"
        }
    }
    
    # Ghost Cleanup: Nuke Registry Keys if they remain
    Write-Output "DEBUG: Checking for Registry orphans..."
    $regPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    
    foreach ($term in $searchTerms) {
        foreach ($path in $regPaths) {
            if (Test-Path $path) {
                Get-ChildItem $path | ForEach-Object {
                    $prop = Get-ItemProperty $_.PsPath
                    if ($prop.DisplayName -like "*$term*") {
                        Write-Output "ORPHAN FOUND: $($prop.DisplayName) in Registry. Deleting key..."
                        Remove-Item -Path $_.PsPath -Recurse -Force
                    }
                }
            }
        }
    }

    exit 0
EOF
)

echo "$UNINSTALL_SCRIPT" | sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" "powershell -NoProfile -Command -"

########################################
# 3. CLEAN CONFIG & FILES
########################################
echo "[Decommission] Final Cleanup (Files & Config)..."

CLEANUP_SCRIPT=$(cat << 'EOF'
    $ErrorActionPreference = 'SilentlyContinue'

    # 1. Config Cleanup
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    $runKey   = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    
    if (Get-ItemProperty -Path $runKey -Name 'LoginEnterpriseLauncher') {
       Remove-ItemProperty -Path $runKey -Name 'LoginEnterpriseLauncher' -Force
    }

    $shortcuts = @(
        (Join-Path [Environment]::GetFolderPath('Startup') 'LoginEnterpriseLauncher.lnk'),
        'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp\LoginEnterpriseLauncher.lnk',
        'C:\Users\Public\Desktop\Login Enterprise Launcher.lnk'
    )
    foreach ($s in $shortcuts) { if (Test-Path $s) { Remove-Item $s -Force } }

    Set-ItemProperty -Path $winlogon -Name 'AutoAdminLogon' -Value '0' -Force
    Remove-ItemProperty -Path $winlogon -Name 'DefaultUserName'
    Remove-ItemProperty -Path $winlogon -Name 'DefaultPassword'
    Remove-ItemProperty -Path $winlogon -Name 'DefaultDomainName'
    Remove-ItemProperty -Path $winlogon -Name 'AutoLogonCount'

    # 2. File Cleanup
    $dirs = @(
        'C:\Program Files\Login VSI\Login Enterprise Launcher',
        'C:\Program Files\Login VSI\Universal Web Connector',
        'C:\ProgramData\LoginVSI\UWC'
    )
    foreach ($d in $dirs) {
        if (Test-Path $d) { 
            Write-Output "Removing: $d"
            Remove-Item -Path $d -Recurse -Force 
        }
    }
    
    exit 0
EOF
)

echo "$CLEANUP_SCRIPT" | sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" "powershell -NoProfile -Command -"

########################################
# 4. REPORT SUCCESS
########################################
echo "[Decommission] Marking launcher as OFFLINE in LM-API..."

# We force the state to 'offline' (or 'stopped')
curl -s -X POST "http://lm-api:8080/api/launchers/${MACHINE_NAME}/state" \
  -H "Content-Type: application/json" \
  -d "{\"state\": \"offline\"}" >/dev/null || true
  
# Mark Autologon as Disabled  <-- INSERT HERE
echo "[Decommission] Disabling Autologon in LM-API..."
curl -s -X POST "http://lm-api:8080/api/launchers/${MACHINE_NAME}/state" \
  -H "Content-Type: application/json" \
  -d "{ \"autologon_enabled\": false }" >/dev/null || true

# Remove necessary fields from launcher record
echo "[Decommission] Wiping launcher data & disabling (commissioned=false)..."
curl -s -X POST "http://lm-api:8080/api/launchers/${MACHINE_NAME}/state" \
  -H "Content-Type: application/json" \
  -d "{ \"commissioned\": false, \"autologon_enabled\": false, \"state\": \"offline\" }" >/dev/null || true
  
curl -s -X POST "http://lm-api:8080/api/automation/runs" \
  -H "Content-Type: application/json" \
  -d "{
    \"machine_name\": \"${MACHINE_NAME}\",
    \"job_name\": \"Decommission Launcher\",
    \"job_type\": \"decommission\",
    \"step_name\": \"decommission-complete\",
    \"status\": \"success\",
    \"result\": { \"decommissioned\": true }
  }" >/dev/null || true

echo "[Decommission] COMPLETE for ${MACHINE_NAME}"
exit 0
