Start-Transcript

$Launcher = "C:\Program Files\Login VSI\Login Enterprise Launcher\LoginEnterprise.Launcher.UI.exe" 

function Launch-CmdLine{
        foreach($instparam in ($instparams = Get-ChildItem -Path $PSScriptRoot -Recurse -Filter "*.cmd")){
                [string]$param = $instparam.FullName
                Write-Host "Installing $instparam" -ForegroundColor Cyan
                & "cmd.exe" "/c" "$param"| Out-Null
                }
}

function Install-Certs{
        foreach($cert in ($certs = Get-ChildItem -Path $PSScriptRoot -Recurse -Filter "*.cer")){
                        [string]$cer = $cert.FullName
                        Write-Host "Installing $cert" -ForegroundColor Cyan
                        Import-Certificate -FilePath "$cer" -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
                }
}

Launch-CmdLine
Install-Certs

 

if ((Test-Path $launcher) -eq $false){

    if (Test-Path ($jsonFile = Get-Childitem -Path $PSScriptRoot -Recurse -Include "appsettings.json" -ErrorAction SilentlyContinue | select-object -first 1)){
        $config = Get-Content $jsonFile.fullname | ConvertFrom-Json
        $setupFile = $jsonFile.Directory.fullname + "\Setup.msi"

        $Serverurl = $config.Serverurl
        $Secret = $config.TokenManager.ClientCredentials.ClientSecret

        $MSIArguments = @(
            "/i"
            $setupFile
            "/qb!"
            "Serverurl=$Serverurl"
            "Secret=$Secret"

        )
        Start-Process "msiexec.exe" -ArgumentList $MSIArguments -Wait
        &$Launcher | Out-Null
        }
}

Stop-Transcript