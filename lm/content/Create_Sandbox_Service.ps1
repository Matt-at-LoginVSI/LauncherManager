# Self-elevate the script if required
if (-Not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')) {
 if ([int](Get-CimInstance -Class Win32_OperatingSystem | Select-Object -ExpandProperty BuildNumber) -ge 6000) {
  $CommandLine = "-File `"" + $MyInvocation.MyCommand.Path + "`" " + $MyInvocation.UnboundArguments
  Start-Process -FilePath PowerShell.exe -Verb Runas -ArgumentList $CommandLine
  Exit
 }
}

function Find-Folders {
    Param (
        [string]$Description = "",
        [string]$SelectedPath = ""

    )

    [Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $browse = New-Object System.Windows.Forms.FolderBrowserDialog
    $browse.SelectedPath = $PSScriptRoot
    $browse.ShowNewFolderButton = $false
    $browse.Description = "Select a directory"

    $loop = $true
    while($loop)
    {
        if ($browse.ShowDialog() -eq "OK")
        {
        $loop = $false
		
		#Insert your script here
		
        } else
        {
            $res = [System.Windows.Forms.MessageBox]::Show("You clicked Cancel. Would you like to try again or exit?", "Select a location", [System.Windows.Forms.MessageBoxButtons]::RetryCancel)
            if($res -eq "Cancel")
            {
                #Ends script
                return
            }
        }
    }
    $browse.SelectedPath
    $browse.Dispose()

}

function Find-File{
    Param (
        [string]$filetype = "",
        [string]$Description = ""

    )
    Add-Type -AssemblyName System.Windows.Forms
    $FileBrowser = New-Object System.Windows.Forms.OpenFileDialog -Property @{
        Multiselect = $false # Multiple files can be chosen
	    Filter = "$Description (*.$filetype)|*.$filetype" # Specified file types

    }
 
    [void]$FileBrowser.ShowDialog()

    $file = $FileBrowser.FileName;

    If($FileBrowser.FileNames -like "*\*") {

	    # Do something 
	    $FileBrowser.FileName #Lists selected files (optional)
	
    }

    else {
        Write-Host "Cancelled by user"
    }
}


$WindowsSandbox = "%windir%\system32\WindowsSandbox.exe"


$wsbfile = Find-File -filetype wsb -Description "Wsb config file"
if($wsbfile -ne $null){
    Write-host "Found: $wsbfile" -ForegroundColor Green
    }else{
    Exit
    }

If ($Env:PROCESSOR_ARCHITECTURE -eq "AMD64"){
    $nssm = Get-Childitem -Path $PSScriptRoot -Recurse -Include "nssm.exe" | Where {$_.Directory -like "*win64*"}
    }else{
    $nssm = Get-Childitem -Path $PSScriptRoot -Recurse -Include "nssm.exe" | Where {$_.Directory -like "*win32*"}
    }


If ($wsbfile -ne $null){
    Copy-Item $nssm.fullname -Destination "$env:SystemRoot\System32\nssm.exe" -Force

    & "$env:SystemRoot\System32\nssm.exe" "install" "LeLauncher" $WindowsSandbox $wsbfile
    Sleep 1
    & "$env:SystemRoot\System32\nssm.exe" "set" "LeLauncher" "DisplayName" "Login Enterprise on Windows Sandbox"
    Sleep 1
    & "$env:SystemRoot\System32\nssm.exe" "set" "LeLauncher" "Description" "This service runs Login Enterprise on Windows Sandbox"
    Sleep 1
    & "$env:SystemRoot\System32\nssm.exe" "set" "LeLauncher" "Type" "SERVICE_INTERACTIVE_PROCESS"
    Sleep 1
}
If ((Get-Service "LeLauncher" -ErrorAction SilentlyContinue) -ne $null){

    Write-host "Windows Sandbox installed successfully as a service" -ForegroundColor Green
}

Pause
