import os
import requests
from fastapi import HTTPException
# IMPORT THE HELPER
from utils import get_secret

class RundeckClient:
    def __init__(self):
        self.base_url = (os.getenv("RUNDECK_URL") or "").rstrip("/")
        
        # CHANGED: Use get_secret() instead of os.getenv()
        self.token = get_secret("RUNDECK_TOKEN") or ""
        
        self.api_version = os.getenv("RUNDECK_API_VERSION", "54")
        self.timeout = int(os.getenv("RUNDECK_TIMEOUT", "30"))
        self.verify = os.getenv("RUNDECK_VERIFY_TLS", "false").lower() == "true"

        if not self.base_url or not self.token:
            # Add debug print to help trace if it fails again
            print(f"DEBUG: Rundeck Config Failure. URL: {self.base_url}, Token Found: {bool(self.token)}")
            raise HTTPException(status_code=500, detail="Rundeck is not configured (RUNDECK_URL/RUNDECK_TOKEN).")

    def _headers(self):
        return {
            "X-Rundeck-Auth-Token": self.token,
            "Accept": "application/json",
            "User-Agent": "LauncherManager/1.0",
        }

    def _request(self, method: str, path: str, **kwargs):
        url = f"{self.base_url}{path}"
        try:
            r = requests.request(
                method,
                url,
                headers=self._headers(),
                timeout=self.timeout,
                verify=self.verify,
                **kwargs
            )
            r.raise_for_status()
            if r.text:
                return r.json()
            return None
        except requests.HTTPError as e:
            detail = f"Rundeck HTTP error: {getattr(e.response, 'text', str(e))}"
            # Log the actual error to container logs for debugging
            print(f"Rundeck API Error: {detail}")
            raise HTTPException(status_code=502, detail=detail)
        except Exception as e:
            print(f"Rundeck Connection Error: {e}")
            raise HTTPException(status_code=502, detail=f"Rundeck request failed: {e}")

    # ... (Rest of your API helpers remain the same) ...
    def job_executions(self, job_id: str, max: int = 20, offset: int = 0):
        return self._request(
            "GET",
            f"/api/{self.api_version}/job/{job_id}/executions",
            params={"max": max, "offset": offset}
        )

    def execution_detail(self, execution_id: int):
        return self._request("GET", f"/api/{self.api_version}/execution/{execution_id}")

    def execution_output(self, execution_id: int, offset: int = 0, lastmod: int = 0):
        return self._request(
            "GET",
            f"/api/{self.api_version}/execution/{execution_id}/output",
            params={
                "offset": offset,
                "lastmod": lastmod,
                "compact": "true",
            }
        )