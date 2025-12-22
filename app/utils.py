import os

def get_secret(key: str, default=None):
    """
    Checks for a Docker Secret file first (mounted at /run/secrets/<key>),
    then falls back to standard environment variables.
    """
    secret_path = f"/run/secrets/{key.lower()}"
    if os.path.exists(secret_path):
        try:
            with open(secret_path, "r") as f:
                return f.read().strip()
        except Exception as e:
            print(f"Warning: Could not read secret file {secret_path}: {e}")
    
    return os.getenv(key, default)