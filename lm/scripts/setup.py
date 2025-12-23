#!/usr/bin/env python3
import os
import sys
import getpass
import subprocess
import ipaddress
import time

# --- Configuration ---

ENV_DIR = "/opt/lm/env"
ENV_FILE = os.path.join(ENV_DIR, ".env")
SETUP_FLAG = os.path.join(ENV_DIR, "setup_required")
GEN_CERT_SCRIPT = "/opt/lm/scripts/gen-cert.sh"

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def header():
    clear_screen()
    print("================================================================")
    print("   Login Enterprise Launcher Manager - Initial Setup")
    print("================================================================")
    print("")

def write_secret_file(filename, content):
    """Writes a value to a text file in /opt/lm/env/ for the API to read."""
    with open(os.path.join(ENV_DIR, filename), "w") as f:
        f.write(content.strip())

def update_dotenv(key, value):
    """Updates or appends a variable in .env (for Docker/Traefik)."""
    lines = []
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, "r") as f:
            lines = f.readlines()

    key_found = False
    new_lines = []
    for line in lines:
        if line.startswith(f"{key}="):
            new_lines.append(f"{key}={value}\n")
            key_found = True
        else:
            new_lines.append(line)
    
    if not key_found:
        new_lines.append(f"{key}={value}\n")

    with open(ENV_FILE, "w") as f:
        f.writelines(new_lines)

def netmask_to_cidr(netmask):
    """Converts 255.255.255.0 -> 24"""
    try:
        return ipaddress.IPv4Network(f"0.0.0.0/{netmask}").prefixlen
    except Exception:
        return None

def configure_network(ip, netmask, gateway, dns, dns_suffix):
    """Applies Static IP using nmcli (NetworkManager)."""
    cidr = netmask_to_cidr(netmask)
    if not cidr:
        print(f"Error: Invalid netmask {netmask}")
        return False

    print(f"\nApplying Network Configuration: {ip}/{cidr}...")
    
    try:
        # Identify the active connection
        cmd = "nmcli -t -f NAME connection show | head -n 1"
        try:
            conn_name = subprocess.check_output(cmd, shell=True).decode().strip()
        except:
            conn_name = ""
            
        if not conn_name:
            conn_name = "Wired connection 1" # Default fallback

        print(f"Modifying connection: '{conn_name}'")

        # Set IPv4 Manual Settings
        subprocess.run(["nmcli", "con", "mod", conn_name, "ipv4.addresses", f"{ip}/{cidr}"], check=True)
        subprocess.run(["nmcli", "con", "mod", conn_name, "ipv4.gateway", gateway], check=True)
        subprocess.run(["nmcli", "con", "mod", conn_name, "ipv4.dns", dns], check=True)
        
        # Set DNS Suffix (Search Domain)
        if dns_suffix:
            subprocess.run(["nmcli", "con", "mod", conn_name, "ipv4.dns-search", dns_suffix], check=True)
        
        subprocess.run(["nmcli", "con", "mod", conn_name, "ipv4.method", "manual"], check=True)
        
        # Apply Changes
        print("Restarting network interface...")
        subprocess.run(["nmcli", "con", "down", conn_name], stdout=subprocess.DEVNULL)
        subprocess.run(["nmcli", "con", "up", conn_name], check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Failed to apply network settings: {e}")
        return False

# -----------------------------------

def configure_os_user(username, password):
    """Creates/Updates Linux user and grants passwordless sudo rights."""
    print(f"Configuring Admin User '{username}'...")
    try:
        # 1. Create user if not exists
        subprocess.run(["useradd", "-m", "-s", "/bin/bash", username], check=False, stderr=subprocess.DEVNULL)

        # 2. Set Password
        p = subprocess.Popen(['chpasswd'], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        p.communicate(input=f"{username}:{password}".encode())
        if p.returncode != 0:
            print("Error: Failed to set OS user password.")
            return False

        # 3. Add to sudo group (Debian uses 'sudo', RHEL uses 'wheel')
        subprocess.run(["usermod", "-aG", "sudo", username], check=False, stderr=subprocess.DEVNULL)
        subprocess.run(["usermod", "-aG", "wheel", username], check=False, stderr=subprocess.DEVNULL)
        
        # 4. Enable Passwordless Sudo (The Fix)
        # We use '99-' prefix to ensure this file loads LAST and overrides any default configs
        sudoers_file = f"/etc/sudoers.d/99-{username}"
        with open(sudoers_file, "w") as f:
            f.write(f"{username} ALL=(ALL) NOPASSWD: ALL\n")
        
        # Secure the file permissions (Linux requires 0440 for sudoers files)
        os.chmod(sudoers_file, 0o440)
        
        return True
    except Exception as e:
        print(f"Failed to configure OS user: {e}")
        return False

# -----------------------------------

def main():
    if not os.path.exists(SETUP_FLAG):
        print("Setup is already complete.")
        print("To factory reset, run: sudo /opt/lm/scripts/seal_appliance.sh")
        return

    header()
    print("Welcome. This wizard will configure your Launcher Manager appliance.")
    print("Settings will be applied immediately upon completion.")
    input("Press [Enter] to begin...")

    # ==========================================
    # STEP 1: NETWORK CONFIGURATION
    # ==========================================
    header()
    print("[ Step 1/4: Network Configuration ]\n")
    
    static_ip = input("Enter Static IP Address : ").strip()
    while not static_ip:
        static_ip = input("Enter Static IP Address : ").strip()

    netmask = input("Enter Netmask (e.g. 255.255.255.0): ").strip()
    while not netmask_to_cidr(netmask):
        print("Invalid Netmask format.")
        netmask = input("Enter Netmask (e.g. 255.255.255.0): ").strip()

    gateway = input("Enter Gateway IP        : ").strip()
    dns = input("Enter DNS Server IP     : ").strip()
    
    # Matching native LE terminology: "DNS Suffix"
    domain = input("Enter DNS Suffix (e.g. loginvsi.com): ").strip()
    while not domain:
        print("DNS Suffix is required for FQDN generation.")
        domain = input("Enter DNS Suffix (e.g. loginvsi.com): ").strip()

    print("\nApplying Network settings...")
    if configure_network(static_ip, netmask, gateway, dns, domain):
        print("Network configured successfully.")
        time.sleep(2)
    else:
        print("Network configuration failed. Check your inputs.")
        if input("Continue anyway? (y/n): ").lower() != 'y':
            sys.exit(1)

    # ==========================================
    # STEP 2: APPLIANCE IDENTITY
    # ==========================================
    header()
    print("[ Step 2/4: Appliance Identity ]\n")
    print(f"Your DNS Suffix is: {domain}")
    print("Enter the Hostname for this appliance (e.g. 'launcher-mgr').")
    
    hostname = input("Hostname: ").strip()
    while not hostname:
        hostname = input("Hostname: ").strip()

    # Auto-Build LM_FQDN
    lm_fqdn = f"{hostname}.{domain}"
    print(f"\n> Full Appliance Name (FQDN): {lm_fqdn}")
    print("> This will be used for SSL Certificates.")
    
    if input("\nIs this correct? (y/n): ").lower() != 'y':
        print("Aborting setup. Please restart.")
        sys.exit(1)

    # Set Linux System Hostname
    try:
        subprocess.run(["hostnamectl", "set-hostname", lm_fqdn], check=False)
        # Update hosts file to prevent sudo warnings/boot hangs
        with open("/etc/hosts", "a") as f:
            f.write(f"\n{static_ip}\t{lm_fqdn}\t{hostname}\n")
    except Exception:
        pass

    # ==========================================
    # STEP 3: LOGIN ENTERPRISE CONNECTION
    # ==========================================
    header()
    print("[ Step 3/4: Login Enterprise Connection ]\n")
    
    le_fqdn = input("Login Enterprise FQDN (e.g. demolab.loginvsi.com): ").strip()
    while not le_fqdn:
        le_fqdn = input("Login Enterprise FQDN: ").strip()

    print("\nNOTE: Ensure your console supports clipboard paste.")
    le_api_token = input("Login Enterprise API Token: ").strip()
    while not le_api_token:
        le_api_token = input("Login Enterprise API Token: ").strip()

    # ==========================================
    # STEP 4: SHARED CREDENTIALS
    # ==========================================
    header()
    print("[ Step 4/4: Login Enterprise Credentials ]\n")
    print("Please provide your basic auth Login Enterprise Credentials (e.g. admin / password123)")
    print("These will be used for Admin access to this Launcher Manager web interface")

    le_ssh_user = input("Enter Username: ").strip()
    while not le_ssh_user:
        le_ssh_user = input("Enter Username: ").strip()

    print(f"\nEnter Password for '{le_ssh_user}'")
    
    le_ssh_pass = ""
    while True:
        p1 = getpass.getpass("Enter Password: ")
        p2 = getpass.getpass("Confirm Password: ")
        if p1 == p2 and p1:
            le_ssh_pass = p1
            break
        print("Passwords do not match. Try again.\n")

    # ==========================================
    # FINALIZING
    # ==========================================
    header()
    print("Writing configuration...")

    try:
        # 1. Update .env with Infrastructure Config
        update_dotenv("LM_FQDN", lm_fqdn)
        update_dotenv("LE_FQDN", le_fqdn)
        update_dotenv("LE_API_TOKEN", le_api_token)
        update_dotenv("COMPOSE_PROFILES", "tools")
        
        # 2. Configure OS User (Sudo/Root Access)
        configure_os_user(le_ssh_user, le_ssh_pass)

        # 3. Source (LE) creds
        write_secret_file("le_ssh_user.txt", le_ssh_user)
        write_secret_file("le_ssh_pass.txt", le_ssh_pass)
        
        # 4. Destination (LM) creds - Same values
        write_secret_file("lm_ssh_user.txt", le_ssh_user)
        write_secret_file("lm_ssh_pass.txt", le_ssh_pass)

        print("Generating SSL certificate...")
        subprocess.run(["chmod", "+x", GEN_CERT_SCRIPT])
        subprocess.run([GEN_CERT_SCRIPT], check=True)

        # Remove Setup Flag (Exit Setup Mode)
        os.remove(SETUP_FLAG)
        print("SUCCESS: Configuration saved.")

    except Exception as e:
        print(f"\nERROR: Failed during configuration write: {e}")
        sys.exit(1)

    print("\nLinking environment file...")
    # Create symlink so Docker Compose can resolve variables like ${PGPASSWORD}
    docker_env_path = "/opt/lm/docker/.env"
    if os.path.exists(docker_env_path) or os.path.islink(docker_env_path):
        os.remove(docker_env_path)
    os.symlink(ENV_FILE, docker_env_path)

    print("\nRestarting Application Services...")
    # Standard start command (Docker now finds the .env automatically via the link)
    os.system("cd /opt/lm/docker && docker compose --profile tools up -d")
    
    print("\n================================================================")
    print("   SETUP COMPLETE")
    print(f"   IP Address:    {static_ip}")
    print(f"   Web Interface: https://{lm_fqdn}/")
    print("================================================================")
    print("\nPress [Enter] to exit to shell.")
    input()

if __name__ == "__main__":
    main()