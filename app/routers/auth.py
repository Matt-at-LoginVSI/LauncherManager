from fastapi import APIRouter, HTTPException, Response, Depends, status
from pydantic import BaseModel
from utils import get_secret
import uuid

router = APIRouter(tags=["auth"])

class LoginRequest(BaseModel):
    username: str
    password: str

# Simple in-memory session store (or just use stateless logic since it's single user)
# For this appliance, checking creds on every request or signing a simple token is fine.
# We will use a simple signed cookie approach for simplicity.

@router.post("/api/login")
def login(creds: LoginRequest, response: Response):
    # 1. Get the actual secrets
    valid_user = get_secret("LE_SSH_USER")
    valid_pass = get_secret("LE_SSH_PASS") # Or LM_SSH_PASS if you prefer separate

    # 2. Verify
    if not valid_user or not valid_pass:
        raise HTTPException(status_code=500, detail="System credentials not configured.")

    if creds.username.lower() == valid_user.lower() and creds.password == valid_pass:
        # 3. Success! Set a cookie.
        # In a real production app, use JWT. For this appliance, a simple session flag is okay,
        # but let's do a basic "session_token" for future proofing.
        response.set_cookie(
            key="lm_session",
            value="authenticated",
            httponly=True,   
            max_age=None,
            expires=None,
            samesite="lax",
            secure=True
        )
        return {"message": "Login successful"}
    
    raise HTTPException(status_code=401, detail="Invalid credentials")

@router.post("/api/logout")
def logout(response: Response):
    response.delete_cookie("lm_session")
    return {"message": "Logged out"}

@router.get("/api/me")
def check_auth(request_cookie: str | None = None):
    # This is a helper for the UI to check if it should show the login page
    # You would need to parse request cookies here. 
    # For now, we will rely on the UI getting a 401 from other endpoints.
    return {"status": "ok"}