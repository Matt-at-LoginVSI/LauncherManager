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

echo "[Commission] Starting commissioning for ${MACHINE_NAME} (Run ${LM_RUN_ID})"

########################################
# 2. Resolve Automation Context (Launcher SSH + Policy)
########################################
CONTEXT_JSON=$(curl -s "http://lm-api:8080/api/automation/resolve/${MACHINE_NAME}")

if [[ -z "$CONTEXT_JSON" || "$CONTEXT_JSON" == "null" ]]; then
  echo "ERROR: LM-API returned null/empty on resolve."
  exit 1
fi

SSH_HOST=$(echo "$CONTEXT_JSON" | jq -r '.ssh.host')
SSH_PORT=$(echo "$CONTEXT_JSON" | jq -r '.ssh.port // 22')
SSH_USER=$(echo "$CONTEXT_JSON" | jq -r '.ssh.username')
SSH_PASS=$(echo "$CONTEXT_JSON" | jq -r '.ssh.secret')
POLICY_JSON=$(echo "$CONTEXT_JSON" | jq -c '.policy // {}')
LE_HOST=$(echo "$CONTEXT_JSON" | jq -r '.le_appliance.fqdn')
LE_USER=$(echo "$CONTEXT_JSON" | jq -r '.le_appliance.ssh_user')
LE_PASS=$(echo "$CONTEXT_JSON" | jq -r '.le_appliance.ssh_pass')
LE_TOKEN=$(echo "$CONTEXT_JSON" | jq -r '.le_appliance.api_token // empty')

if [[ -z "$LE_HOST" || -z "$LE_USER" || -z "$LE_PASS" ]]; then
  echo "ERROR: LM-API did not return LE appliance credentials."
  exit 1
fi

LM_HOST=$(echo "$CONTEXT_JSON" | jq -r '.le_appliance.lm_fqdn')
LM_USER=$(echo "$CONTEXT_JSON" | jq -r '.le_appliance.lm_ssh_user')
LM_PASS=$(echo "$CONTEXT_JSON" | jq -r '.le_appliance.lm_ssh_pass')

if [[ -z "$LM_HOST" || "$LM_HOST" == "null" ]]; then
    echo "ERROR: LM-API did not return LM appliance credentials."
    exit 1
fi

echo "[Commission] Launcher SSH → $SSH_USER@$SSH_HOST:$SSH_PORT"

########################################
# 3. Derive flags from simplified policy
# policy.launcher.{launcher, uwc, secure, autologon, uwcPullScripts}
########################################
INSTALL_ENABLED=$(echo "$POLICY_JSON"      | jq -r '.launcher.launcher      // false')
UWC_ENABLED=$(echo "$POLICY_JSON"          | jq -r '.launcher.uwc           // false')
SECURE_ENABLED=$(echo "$POLICY_JSON"       | jq -r '.launcher.secure        // false')
AUTO_ENABLED=$(echo "$POLICY_JSON"         | jq -r '.launcher.autologon     // false')
PULL_UWC_SCRIPTS=$(echo "$POLICY_JSON"     | jq -r '.launcher.uwcPullScripts // false')

# If secure mode is enabled, force autologon off
if [[ "$SECURE_ENABLED" == "true" && "$AUTO_ENABLED" == "true" ]]; then
  echo "[Commission] secure=true and autologon=true — forcing autologon=false."
  AUTO_ENABLED="false"
fi

########################################
# 4. Test Launcher SSH
########################################
echo "[Commission] Testing SSH connectivity..."
if ! sshpass -p "$SSH_PASS" ssh \
    -o StrictHostKeyChecking=no \
    -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "hostname"; then
  echo "ERROR: SSH connectivity to launcher failed."
  exit 1
fi
echo "[Commission] SSH connectivity OK."

########################################
# 5. Defaults (URLs, paths, service names)
########################################
DEFAULT_INSTALL_URL="https://${LE_HOST}/contentDelivery/content/zip/launcher_win10_x64.zip"
DEFAULT_UWC_URL="https://${LE_HOST}/contentDelivery/content/zip/universal_web_connector_win10_x64.zip"
# Retrieve Windows TEMP folder path on launcher
TEMP_PATH=$(sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no \
  "$SSH_USER@$SSH_HOST" 'powershell -NoProfile -Command "$env:TEMP"')

if [[ -z "$TEMP_PATH" ]]; then
  echo "ERROR: Could not retrieve TEMP path from launcher."
  exit 1
fi

echo "[Commission] Launcher TEMP path: $TEMP_PATH"

INSTALL_URL="$DEFAULT_INSTALL_URL"
UWC_URL="$DEFAULT_UWC_URL"

HOST_FOLDER="C:\\HostFolder"
UWC_SCRIPTS_PATH="C:\\ProgramData\\LoginVSI\\UWC\\Scripts"
SERVICE_NAME="Login Enterprise"
SANDBOX_CONFIG_FILE="${HOST_FOLDER}\\SandboxConfig.wsb"

########################################
# 6. Secure Launcher Setup (Windows Sandbox)
########################################
if [[ "$SECURE_ENABLED" == "true" ]]; then
  echo "[Commission] Secure Launcher mode enabled."
  
  # 1. DEFINE PATHS
  SECURE_HOST_PATH="C:\\SecureLauncher"
  SECURE_BINARIES="${SECURE_HOST_PATH}\\Binaries"
  WSB_FILE="${SECURE_HOST_PATH}\\SandboxConfig.wsb"
  BOOTSTRAP_FILE="${SECURE_HOST_PATH}\\Bootstrap.ps1"
  NSSM_EXE="${SECURE_HOST_PATH}\\nssm.exe"
  SERVICE_NAME="LoginEnterpriseSecure"
  
  # Paths on LM Appliance (User: root)
  LM_CONTENT_PATH="/opt/lm/content"
  LM_FILES=("Create_Sandbox_Service.ps1" "Enable_Windows_Sandbox.ps1" "InstallLauncher.ps1" "nssm-2.24.zip" "SandboxConfig.wsb")
  
  # 2. ENABLE WINDOWS SANDBOX
  echo "[Commission] Enabling Windows Sandbox feature..."
  sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
    "powershell -NoProfile -Command \"\
      Enable-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM' -All -NoRestart -ErrorAction SilentlyContinue; \
      Write-Output 'Windows Sandbox feature enabled.'; \
    \""

  # 3. DOWNLOAD SECURE RESOURCES (FROM LM APPLIANCE - lab-lemgr-01)
  echo "[Commission] Downloading Secure Launcher assets from LM Appliance ($LM_HOST)..."
  
  # Clean/Create Temp Directory on Launcher
  sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
     "powershell -NoProfile -Command \"If (Test-Path '${TEMP_PATH}\\LMContent') { Remove-Item -Recurse -Force '${TEMP_PATH}\\LMContent' }; New-Item -ItemType Directory -Path '${TEMP_PATH}\\LMContent' | Out-Null\""

  # Construct SFTP Batch Command
  sftp_cmds=""
  for file in "${LM_FILES[@]}"; do
      sftp_cmds+="get \"$LM_CONTENT_PATH/$file\" \"${TEMP_PATH}\\LMContent\\$file\""$'\n'
  done

  # Execute SFTP using LM Credentials (root / LM_SSH_PASS)
  if ! echo "$sftp_cmds" | sshpass -p "$LM_PASS" sftp -o StrictHostKeyChecking=no -P 22 "$LM_USER@$LM_HOST"; then
     echo "ERROR: Failed to download files from LM Appliance ($LM_HOST)."
     exit 1
  fi
  
  # 4. DOWNLOAD LAUNCHER ZIP (FROM LE APPLIANCE - lab-le-01)
  # Standard Launcher binaries still live on the main LE appliance
  echo "[Commission] Downloading Launcher ZIP from LE Appliance ($LE_HOST)..."
  if ! echo "get \"/loginvsi/content/zip/launcher_win10_x64.zip\" \"${TEMP_PATH}\\launcher.zip\"" | \
       sshpass -p "$LE_PASS" sftp -o StrictHostKeyChecking=no -P 22 "$LE_USER@$LE_HOST"; then
       echo "ERROR: Failed to download Launcher ZIP from LE Appliance."
       exit 1
  fi

  # 5. PREPARE HOST FOLDER & EXTRACT BINARIES
  echo "[Commission] Setting up Host Folder & Extracting Binaries..."
  
  sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
    "powershell -NoProfile -Command \"\
      \$hostPath = '${SECURE_HOST_PATH}'; \
      \$binDir   = '${SECURE_BINARIES}'; \
      \$zip      = '${TEMP_PATH}\\launcher.zip'; \
      \$lmContent = '${TEMP_PATH}\\LMContent'; \
      \$nssmZip  = Join-Path \$lmContent 'nssm-2.24.zip'; \
      \
      # A. Clean Start \
      if (Test-Path \$hostPath) { Remove-Item -Path \$hostPath -Recurse -Force -ErrorAction SilentlyContinue }; \
      New-Item -ItemType Directory -Path \$binDir -Force | Out-Null; \
      \
      # B. Extract NSSM (from LM zip) \
      Write-Output 'Extracting NSSM...'; \
      Add-Type -AssemblyName System.IO.Compression.FileSystem; \
      [System.IO.Compression.ZipFile]::ExtractToDirectory(\$nssmZip, \$lmContent); \
      # Find nssm.exe (usually in win64 subfolder) \
      \$nssmSrc = Get-ChildItem -Path \$lmContent -Recurse -Filter 'nssm.exe' | Where-Object { \$_.FullName -like '*win64*' } | Select-Object -First 1; \
      if (\$nssmSrc) { Copy-Item -Path \$nssmSrc.FullName -Destination '${NSSM_EXE}' -Force } \
      else { Write-Error 'Could not find nssm.exe in extracted zip'; exit 1 }; \
      \
      # C. Administrative Install of Launcher (Extract binaries) \
      Write-Output 'Extracting Launcher Binaries...'; \
      \$extract = '${TEMP_PATH}\\LauncherExtract'; \
      if (Test-Path \$extract) { Remove-Item -Path \$extract -Recurse -Force }; \
      [System.IO.Compression.ZipFile]::ExtractToDirectory(\$zip, \$extract); \
      \$msi = Get-ChildItem -Path \$extract -Filter *.msi | Select-Object -First 1; \
      Start-Process 'msiexec.exe' -ArgumentList '/a', \$msi.FullName, ('TARGETDIR=' + \$binDir), '/qn' -Wait; \
      \
      # D. Locate actual Launcher Folder \
      \$realLauncher = Get-ChildItem -Path \$binDir -Recurse -Filter 'LoginEnterprise.Launcher.UI.exe' | Select-Object -First 1; \
      \$launcherFolder = \$realLauncher.DirectoryName; \
      \
      # E. Configure AppSettings (Using LE_HOST for Connection) \
      Write-Output 'Configuring appSettings.json...'; \
      \$configFile = Join-Path \$launcherFolder 'appSettings.json'; \
      if (Test-Path \$configFile) { \
         \$j = Get-Content \$configFile -Raw | ConvertFrom-Json; \
         if (-not \$j.LauncherSettings) { \$j | Add-Member -MemberType NoteProperty -Name 'LauncherSettings' -Value (@{}) -Force }; \
         \$j.LauncherSettings.LauncherName = '${MACHINE_NAME}'; \
         \$j.LauncherSettings.ServerUrl = 'https://${LE_HOST}'; \
         \$j.LauncherSettings.Secret = '${LE_TOKEN}'; \
         \$j | ConvertTo-Json -Depth 10 | Set-Content \$configFile -Force; \
      } \
      \
      # F. Copy Helper Scripts \
      Copy-Item -Path (Join-Path \$lmContent 'SandboxConfig.wsb') -Destination '${WSB_FILE}' -Force; \
      Copy-Item -Path (Join-Path \$lmContent 'Create_Sandbox_Service.ps1') -Destination (Join-Path \$hostPath 'Create_Sandbox_Service.ps1') -Force; \
    \""

  # 6. DYNAMIC WSB & BOOTSTRAP GENERATION
  echo "[Commission] Generating Configs with correct paths..."
  sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
    "powershell -NoProfile -Command \"\
      \$realLauncher = Get-ChildItem -Path '${SECURE_BINARIES}' -Recurse -Filter 'LoginEnterprise.Launcher.UI.exe' | Select-Object -First 1; \
      \$launcherFolder = \$realLauncher.DirectoryName; \
      \
      # 1. Generate Bootstrap.ps1 \
      \$bootstrapContent = @\\\" \
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Force \
\$path = 'C:\\Users\\WDAGUtilityAccount\\Desktop\\Launcher\\LoginEnterprise.Launcher.UI.exe' \
Start-Process -FilePath \$path -Wait \
\\\"; \
      Set-Content -Path '${BOOTSTRAP_FILE}' -Value \$bootstrapContent; \
      \
      # 2. Update .wsb with Correct Host Paths \
      \$wsbContent = @\\\" \
<Configuration> \
  <VGpu>Enable</VGpu> \
  <Networking>Enable</Networking> \
  <MappedFolders> \
    <MappedFolder> \
      <HostFolder>\$launcherFolder</HostFolder> \
      <SandboxFolder>C:\\Users\\WDAGUtilityAccount\\Desktop\\Launcher</SandboxFolder> \
      <ReadOnly>false</ReadOnly> \
    </MappedFolder> \
    <MappedFolder> \
      <HostFolder>${SECURE_HOST_PATH}</HostFolder> \
      <SandboxFolder>C:\\Users\\WDAGUtilityAccount\\Desktop\\Config</SandboxFolder> \
      <ReadOnly>true</ReadOnly> \
    </MappedFolder> \
  </MappedFolders> \
  <LogonCommand> \
    <Command>powershell.exe -ExecutionPolicy Bypass -File C:\\Users\\WDAGUtilityAccount\\Desktop\\Config\\Bootstrap.ps1</Command> \
  </LogonCommand> \
</Configuration> \
\\\"; \
      Set-Content -Path '${WSB_FILE}' -Value \$wsbContent; \
    \""

  # 7. INSTALL SERVICE
  echo "[Commission] Installing Secure Service..."
  sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
    "powershell -NoProfile -Command \"\
      \$nssm = '${NSSM_EXE}'; \
      \$wsb  = '${WSB_FILE}'; \
      \$sandboxExe = Join-Path \$env:windir 'System32\\WindowsSandbox.exe'; \
      \
      Stop-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue; \
      & \$nssm remove '${SERVICE_NAME}' confirm; \
      & \$nssm install '${SERVICE_NAME}' \$sandboxExe \$wsb; \
      & \$nssm set '${SERVICE_NAME}' AppExit Default Restart; \
      Start-Service -Name '${SERVICE_NAME}'; \
    \""

  echo "[Commission] Secure Launcher Setup Complete."
else
  echo "[Commission] Secure Launcher mode disabled."
fi

########################################
# 7. INSTALL LAUNCHER (ZIP + MSI) — host OS
########################################
if [[ "$INSTALL_ENABLED" == "true" ]]; then
  echo "[Commission] Launcher install enabled (host OS)."
  
  # Path on the Appliance (verified from your SCP error logs)
  LE_FILE_PATH="/loginvsi/content/zip/launcher_win10_x64.zip"
  LOCAL_ZIP="/tmp/launcher.zip"

  echo "[Commission] Downloading via SFTP (Attempting to bypass Admin TUI)..."

  # EXPERT NOTE: We pipe the 'get' command into sftp to run non-interactively.
  # We use -P 22 explicitly.
  # This relies on the SSHD config allowing the 'sftp' subsystem, which bypasses the shell menu.
  
  if ! echo "get \"$LE_FILE_PATH\" \"$LOCAL_ZIP\"" | \
       sshpass -p "$LE_PASS" sftp \
       -o StrictHostKeyChecking=no \
       -o ConnectTimeout=10 \
       -P 22 \
       "$LE_USER@$LE_HOST"; then
       
       echo "ERROR: SFTP download failed."
       echo "  Possible causes:"
       echo "  1. The 'sftp-server' subsystem is disabled in /etc/ssh/sshd_config on the appliance."
       echo "  2. The path '$LE_FILE_PATH' is incorrect."
       exit 1
  fi

  # Verify the download worked (Size > 0)
  if [[ ! -s "$LOCAL_ZIP" ]]; then
    echo "ERROR: SFTP succeeded but downloaded file is empty."
    exit 1
  fi

  echo "[Commission] File downloaded successfully ($(stat -c%s "$LOCAL_ZIP") bytes)."

  echo "[Commission] Copying launcher ZIP to target launcher machine..."
  sshpass -p "$SSH_PASS" scp -P "$SSH_PORT" -o StrictHostKeyChecking=no \
    "$LOCAL_ZIP" "$SSH_USER@$SSH_HOST:${TEMP_PATH}\\launcher.zip"

  echo "[Commission] Extracting launcher ZIP + installing MSI on host..."
    sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
      "powershell -NoProfile -Command \"\
        \$zip='${TEMP_PATH}\\launcher.zip'; \
        \$out='${TEMP_PATH}\\LauncherExtract'; \
        Write-Output 'Cleaning previous extraction...'; \
        if (Test-Path \$out) { Remove-Item -Path \$out -Recurse -Force | Out-Null }; \
        New-Item -ItemType Directory -Path \$out -Force | Out-Null; \
        Add-Type -AssemblyName System.IO.Compression.FileSystem; \
        [System.IO.Compression.ZipFile]::ExtractToDirectory(\$zip, \$out); \
        \$msi = Get-ChildItem -Path \$out -Filter *.msi | Select-Object -First 1; \
        if (-not \$msi) { Write-Error 'No MSI found in launcher ZIP.'; exit 1 }; \
        Start-Process 'msiexec.exe' -ArgumentList '/i', \$msi.FullName, '/qn', '/norestart' -Wait; \
      \""

  echo "[Commission] Launcher installation on host complete."
else
  echo "[Commission] Launcher install disabled — skipping host MSI install."
fi

########################################
# 8. UWC INSTALLATION + SCRIPT SYNC
########################################
if [[ "$UWC_ENABLED" == "true" ]]; then
  echo "[Commission] UWC deployment enabled."

  # 1. DOWNLOAD
  LE_UWC_PATH="/loginvsi/content/zip/universal_web_connector_win10_x64.zip"
  LOCAL_UWC_ZIP="/tmp/uwc.zip"

  echo "[Commission] Downloading UWC via SFTP..."
  if ! echo "get \"$LE_UWC_PATH\" \"$LOCAL_UWC_ZIP\"" | \
       sshpass -p "$LE_PASS" sftp -o StrictHostKeyChecking=no -o ConnectTimeout=10 -P 22 "$LE_USER@$LE_HOST"; then
       echo "ERROR: SFTP download for UWC failed."
       exit 1
  fi

  if [[ ! -s "$LOCAL_UWC_ZIP" ]]; then
    echo "ERROR: UWC ZIP download failed or file is empty."
    exit 1
  fi

  # 2. COPY TO VM
  echo "[Commission] Copying UWC ZIP to launcher machine..."
  sshpass -p "$SSH_PASS" scp -P "$SSH_PORT" -o StrictHostKeyChecking=no \
    "$LOCAL_UWC_ZIP" "$SSH_USER@$SSH_HOST:${TEMP_PATH}\\uwc.zip"

  # 3. INSTALL MSI (Clean Version with Rename Fix)
  echo "[Commission] Extracting UWC ZIP + installing MSI..."
  
  if ! sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
    "powershell -Command \"\
      \$zip='${TEMP_PATH}\\uwc.zip'; \
      \$out='${TEMP_PATH}\\UWCExtract'; \
      \
      Write-Output '1. extracting zip...'; \
      if (Test-Path \$out) { Remove-Item -Path \$out -Recurse -Force | Out-Null }; \
      New-Item -ItemType Directory -Path \$out -Force | Out-Null; \
      Add-Type -AssemblyName System.IO.Compression.FileSystem; \
      [System.IO.Compression.ZipFile]::ExtractToDirectory(\$zip, \$out); \
      \
      Write-Output '2. Renaming MSI to remove spaces...'; \
      \$original = Get-ChildItem -Path \$out -Filter *.msi | Select-Object -First 1; \
      if (-not \$original) { Write-Error 'No MSI found.'; exit 1 }; \
      \
      \$fixed = Join-Path -Path \$out -ChildPath 'uwc_setup.msi'; \
      Rename-Item -Path \$original.FullName -NewName 'uwc_setup.msi' -Force; \
      Unblock-File -Path \$fixed; \
      \
      Write-Output '3. Running Installation...'; \
      \$proc = Start-Process 'msiexec.exe' -ArgumentList '/i', \$fixed, '/qn', '/norestart' -Wait -PassThru; \
      \
      if (\$proc.ExitCode -ne 0) { \
          Write-Error ('Installation failed with exit code: ' + \$proc.ExitCode); \
          exit 1; \
      } \
      Write-Output 'Installation successful.'; \
    \""; then
    
    echo "ERROR: UWC Remote Installation Failed."
    exit 1
  fi

  # 4. SCRIPT SYNC
      if [[ "$PULL_UWC_SCRIPTS" == "true" ]]; then
        echo "[Commission] Script Sync Enabled: Configuring Scripts folder..."
        
        # 4a. Ensure Destination Exists
        sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
          "powershell -NoProfile -Command \"\
            \$dest='${UWC_SCRIPTS_PATH}'; \
            if (-not (Test-Path \$dest)) { New-Item -ItemType Directory -Path \$dest -Force | Out-Null }; \
          \""
          
        # 4b. Clean local temp
        rm -rf /tmp/uwc-scripts
        mkdir -p /tmp/uwc-scripts

        echo "[Commission] Pulling scripts via SFTP (Recursive)..."
        # Use SFTP -r to bypass the Admin Menu blocking SCP
        if echo "get -r /loginvsi/content/scripts /tmp/uwc-scripts" | \
            sshpass -p "$LE_PASS" sftp -o StrictHostKeyChecking=no -P 22 "$LE_USER@$LE_HOST"; then
            
            # 4c. Push to Launcher
            echo "[Commission] Pushing scripts to Launcher..."
            # SFTP 'get -r' creates the 'scripts' directory inside /tmp/uwc-scripts/
            sshpass -p "$SSH_PASS" scp -r -P "$SSH_PORT" -o StrictHostKeyChecking=no \
              /tmp/uwc-scripts/scripts/* "$SSH_USER@$SSH_HOST:${UWC_SCRIPTS_PATH}\\"

            # 4d. UNZIP WORKLOADS (NEW)
            echo "[Commission] Expanding workload ZIPs on Launcher..."
            sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
              "powershell -NoProfile -Command \"\
                \$scriptDir = '${UWC_SCRIPTS_PATH}'; \
                \$zips = Get-ChildItem -Path \$scriptDir -Filter '*.zip'; \
                if (\$zips.Count -gt 0) { \
                    foreach (\$zip in \$zips) { \
                        Write-Output ('Extracting ' + \$zip.Name + '...'); \
                        Expand-Archive -Path \$zip.FullName -DestinationPath \$scriptDir -Force; \
                    } \
                } else { \
                    Write-Output 'No ZIP files found to extract.'; \
                } \
              \""

        else
            echo "WARNING: Could not pull scripts from Appliance."
        fi
      fi

  echo "[Commission] UWC deployment complete."
else
  echo "[Commission] UWC disabled — skipping."
fi

########################################
# 9. Configure Autologon & Startup (host OS)
########################################
if [[ "$AUTO_ENABLED" == "true" ]]; then
  echo "[Commission] Configuring permanent autologon and startup..."

  # 1. Prepare Credentials (Bash Side)
  DOMAIN=""
  USER="$SSH_USER"
  if [[ "$SSH_USER" == *"\\"* ]]; then
    DOMAIN="${SSH_USER%%\\*}"
    USER="${SSH_USER##*\\}"
  fi

  # 2. Prepare Variables Block (Bash -> PowerShell Injection)
  # We escape single quotes ( ' -> '' ) to prevent breaking the PowerShell string.
  SafeUser="${USER//\'/\'\'}"
  SafePass="${SSH_PASS//\'/\'\'}"
  SafeDomain="${DOMAIN//\'/\'\'}"

  PS_VARS="
    \$User = '${SafeUser}'
    \$Pass = '${SafePass}'
    \$Domain = '${SafeDomain}'
  "

  # 3. Define the Main Logic (Protected Heredoc)
  # This block is pure PowerShell. Bash variables are NOT expanded here.
  PS_BODY=$(cat << 'EOF'
    $ErrorActionPreference = "Stop"
    Write-Output "--- START CONFIG ---"

    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    $policies = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    $runKey   = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    
    # --- A. AUTOLOGON ---
    Write-Output "Setting Winlogon for User: $User"
    Set-ItemProperty -Path $winlogon -Name 'AutoAdminLogon'  -Value '1' -Type String -Force
    Set-ItemProperty -Path $winlogon -Name 'DefaultUserName' -Value $User -Type String -Force
    Set-ItemProperty -Path $winlogon -Name 'DefaultPassword' -Value $Pass -Type String -Force
    
    if (-not [string]::IsNullOrEmpty($Domain)) {
        Set-ItemProperty -Path $winlogon -Name 'DefaultDomainName' -Value $Domain -Type String -Force
    }

    # --- B. POLICIES ---
    Write-Output "Disabling conflicting policies..."
    Set-ItemProperty -Path $winlogon -Name 'DontDisplayLastUsername' -Value '0' -Type String -Force
    if (-not (Test-Path $policies)) { New-Item -Path $policies -Force | Out-Null }
    Set-ItemProperty -Path $policies -Name 'DisableAutomaticRestartSignOn' -Value 0 -Type DWord -Force
    Remove-ItemProperty -Path $winlogon -Name 'AutoLogonCount' -ErrorAction SilentlyContinue

    # --- C. STARTUP SHORTCUT ---
    # 1. Clean up legacy Registry Key (if present) to prevent conflicts
    if (Get-ItemProperty -Path $runKey -Name 'LoginEnterpriseLauncher' -ErrorAction SilentlyContinue) {
        Write-Output "Removing legacy Registry Run key..."
        Remove-ItemProperty -Path $runKey -Name 'LoginEnterpriseLauncher' -Force
    }

    $targetExe = 'C:\Program Files\Login VSI\Login Enterprise Launcher\LoginEnterprise.Launcher.UI.exe'
    
    # 2. Use Current User Startup Folder (Guaranteed Writable)
    $startupDir = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startupDir 'LoginEnterpriseLauncher.lnk'

    Write-Output "Creating Shortcut at: $shortcutPath"
    
    # 3. Verify Target Exists
    if (-not (Test-Path $targetExe)) {
        Write-Error "TARGET EXE NOT FOUND at $targetExe. Cannot create shortcut."
        exit 1
    }

    # 4. Create Shortcut
    try {
        $wsh = New-Object -ComObject WScript.Shell
        $lnk = $wsh.CreateShortcut($shortcutPath)
        $lnk.TargetPath = $targetExe
        $lnk.Save()
    } catch {
        Write-Error "FAILED to save shortcut: $($_.Exception.Message)"
        exit 1
    }

    # 5. Verify Creation
    if (Test-Path $shortcutPath) {
        Write-Output "SUCCESS: Shortcut created."
    } else {
        Write-Error "ERROR: Shortcut file not found after save."
        exit 1
    }
EOF
)

  # 4. Execute Combined Script via Pipe
  # We combine the variables + body and pipe it into PowerShell. 
  # Note: We removed the invalid arguments passed to -Command.
  echo "$PS_VARS $PS_BODY" | sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
      "powershell -NoProfile -Command -"

  if [[ $? -ne 0 ]]; then
      echo "ERROR: Failed to configure Autologon/Startup."
      exit 1
  fi

  echo "[Commission] Autologon and Startup configured."
else
  echo "[Commission] Autologon disabled — skipping."
fi
########################################
# 10. Update LauncherName in host appSettings.json (host OS)
########################################
echo "[Commission] Updating host appSettings.json LauncherName to '${MACHINE_NAME}'..."

sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
  "powershell -NoProfile -Command \"\
    \$file = 'C:\\Program Files\\Login VSI\\Login Enterprise Launcher\\appSettings.json'; \
    if (-not (Test-Path \$file)) { \
      Write-Output 'WARNING: host appSettings.json not found at ' + \$file; \
    } else { \
      \$j = Get-Content \$file -Raw | ConvertFrom-Json; \
      if (-not \$j.LauncherSettings) { \
        \$j | Add-Member -MemberType NoteProperty -Name 'LauncherSettings' -Value (@{}) -Force \
      }; \
      \$j.LauncherSettings.LauncherName = '${MACHINE_NAME}'; \
      \$j | ConvertTo-Json -Depth 10 | Set-Content \$file -Force; \
      Write-Output \"[Commission] Updated host LauncherName to '${MACHINE_NAME}' in \$file\"; \
    }\
  \""

########################################
# 11. VALIDATION (Check Install Directories)
########################################
echo "[Commission] Validating installation directories..."

sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
  "powershell -NoProfile -Command \"\
    \$launcherPath = 'C:\Program Files\Login VSI\Login Enterprise Launcher'; \
    \$uwcPath = 'C:\Program Files\Login VSI\Universal Web Connector'; \
    \$errors = @(); \
    \
    if (-not (Test-Path \$launcherPath)) { \$errors += 'Launcher directory missing'; } \
    if (-not (Test-Path \$uwcPath)) { \$errors += 'UWC directory missing'; } \
    \
    if (\$errors.Count -gt 0) { \
       Write-Error ('Validation Failed: ' + (\$errors -join ', ')); \
       exit 1; \
    } \
    Write-Output 'Validation Successful: Launcher and UWC directories exist.'; \
  \""
  
########################################
# 12. Update Autologon Status in DB
########################################
echo "[Commission] Updating launcher record (autologon_enabled=${AUTO_ENABLED})..."

# Note: We use the existing /state endpoint via POST
curl -s -X POST "http://lm-api:8080/api/launchers/${MACHINE_NAME}/state" \
  -H "Content-Type: application/json" \
  -d "{ \"autologon_enabled\": ${AUTO_ENABLED} }" >/dev/null || true

########################################
# 13. Report Success to LM-API
########################################
echo "[Commission] Reporting success to LM-API..."
curl -s -X POST "http://lm-api:8080/api/automation/runs" \
  -H "Content-Type: application/json" \
  -d "{
    \"machine_name\": \"${MACHINE_NAME}\",
    \"job_name\": \"Commission Launcher\",
    \"job_type\": \"commission\",
    \"step_name\": \"commission-complete\",
    \"status\": \"success\",
    \"result\": {
      \"install_enabled\": ${INSTALL_ENABLED},
      \"uwc_enabled\": ${UWC_ENABLED},
      \"autologon_enabled\": ${AUTO_ENABLED},
      \"secure_launcher_enabled\": ${SECURE_ENABLED},
      \"uwc_scripts_from_le\": ${PULL_UWC_SCRIPTS}
    }
  }" >/dev/null || true

echo "[Commission] Updating launcher record (commissioned=true)..."
curl -s -X POST "http://lm-api:8080/api/launchers/${MACHINE_NAME}/state" \
  -H "Content-Type: application/json" \
  -d "{ \"autologon_enabled\": ${AUTO_ENABLED}, \"commissioned\": true }" >/dev/null || true

echo "[Commission] Triggering 'Start Launcher' job via LM-API..."
curl -s -X POST "http://lm-api:8080/api/launchers/${MACHINE_NAME}/start" \
  -H "Content-Type: application/json" >/dev/null

echo "[Commission] COMPLETE for ${MACHINE_NAME}"
exit 0
