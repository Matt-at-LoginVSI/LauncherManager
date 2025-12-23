from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi import Cookie
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime
import json, os, psycopg2
from psycopg2.extras import RealDictCursor, Json
import requests
from cryptography.fernet import Fernet
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from starlette.responses import StreamingResponse
from starlette.requests import Request
import anyio
import queue
import threading
import time
import uuid
import csv
import io
from routers.rundeck import router as rundeck_router
from utils import get_secret
from routers import auth

app = FastAPI()

# --- START SECURITY & SETUP MIDDLEWARE ---

# Path inside container where we look for the setup flag
# NOTE: You must update docker-compose to mount /opt/lm/env to /env_mount for this to work!
SETUP_FLAG_PATH = "/env_mount/setup_required" 
ENV_MOUNT_PATH = "/env_mount"

@app.middleware("http")
async def security_guard(request: Request, call_next):
    path = request.url.path

    # --- 1. SETUP BLOCKER (CONSOLE ONLY) ---
    # If the setup flag exists, the appliance is not configured.
    # Block ALL web access and tell the user to go to the VM Console.
    if os.path.exists(SETUP_FLAG_PATH):
        return HTMLResponse(
            content="""
            <!DOCTYPE html>
            <html>
            <head>
                <title>Setup Required</title>
                <style>
                    body { font-family: 'Segoe UI', sans-serif; background-color: #f4f4f4; text-align: center; padding-top: 100px; }
                    .card { background: white; max-width: 600px; margin: auto; padding: 40px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
                    h1 { color: #333; }
                    p { color: #666; font-size: 1.1em; }
                    .highlight { background: #eee; padding: 5px 10px; border-radius: 4px; font-weight: bold; font-family: monospace; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>Appliance Setup Required</h1>
                    <p>This Launcher Manager has not been configured yet.</p>
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                    <p>Please log in to the <b>VM Console</b> to run the setup wizard.</p>
                </div>
            </body>
            </html>
            """,
            status_code=503
        )

    # --- 2. AUTHENTICATION MODE ---
    # Whitelist: Paths that don't need login
    public_paths = [
        "/api/login",
        "/api/le-version",
        "/static/login.html",
        "/static/css/main.css",
        "/static/img",
        "/favicon.ico",
        "/api/automation",
        "/api/launchers"
    ]

    # Check if path is public
    is_public = any(path.startswith(p) for p in public_paths)

    if not is_public:
        # Check for the session cookie set by auth.py
        session_token = request.cookies.get("lm_session")
        
        if not session_token:
            # If it's an API call, return 401 (so UI JavaScript handles it)
            if path.startswith("/api"):
                return JSONResponse(status_code=401, content={"detail": "Not authenticated"})
            
            # If it's a browser navigation (root, /ui), redirect to Login Page
            return RedirectResponse("/static/login.html")

    response = await call_next(request)
    return response

# --- END SECURITY & SETUP MIDDLEWARE ---

app.mount("/static", StaticFiles(directory="/app/static"), name="static")
app.include_router(rundeck_router)  # or add prefix/tags here
app.include_router(auth.router)

# --- SSE EVENT BROKER ---
class EventBroker:
    def __init__(self):
        self._lock = threading.Lock()
        self._clients: dict[str, queue.Queue] = {}

    def subscribe(self) -> tuple[str, queue.Queue]:
        client_id = str(uuid.uuid4())
        q: queue.Queue = queue.Queue(maxsize=200)
        with self._lock:
            self._clients[client_id] = q
        return client_id, q

    def unsubscribe(self, client_id: str) -> None:
        with self._lock:
            self._clients.pop(client_id, None)

    def publish(self, event: str, data: dict) -> None:
        msg = {"event": event, "data": data}
        with self._lock:
            for q in list(self._clients.values()):
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    # drop oldest and try once more
                    try:
                        q.get_nowait()
                    except queue.Empty:
                        pass
                    try:
                        q.put_nowait(msg)
                    except queue.Full:
                        pass


BROKER = EventBroker()

def _sse(event: str, data: dict) -> bytes:
    # SSE format: "event: <name>\ndata: <json>\n\n"
    payload = json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n".encode("utf-8")

# --- RUNDECK EXECUTION WATCHER (publishes SSE: "rundeck_execution") ---

RUNDECK_WATCH_LOCK = threading.Lock()
RUNDECK_WATCHING: dict[int, dict] = {}  # {executionId: {"last": "...", "errors": 0}}

def _parse_opt(argstring: str, opt: str) -> str | None:
    if not argstring:
        return None
    import re
    m = re.search(rf"(?:^|\s)-{re.escape(opt)}(?:=|\s+)(\S+)", str(argstring), re.IGNORECASE)
    return m.group(1) if m else None

def _rundeck_get_execution_detail(execution_id: int) -> dict:
    token = get_secret("RUNDECK_TOKEN")
    url = os.getenv("RUNDECK_URL")  # MUST already include /rundeck in your setup
    if not token or not url:
        raise RuntimeError("RUNDECK_URL or RUNDECK_TOKEN missing")

    r = requests.get(
        f"{url}/api/54/execution/{execution_id}",
        headers={
            "X-Rundeck-Auth-Token": token,
            "Accept": "application/json",
        },
        timeout=15,
        verify=False,
    )
    r.raise_for_status()
    return r.json()

def _rundeck_detail_to_event(detail: dict, execution_id: int) -> dict:
    job = detail.get("job") or {}
    argstring = detail.get("argstring") or ""

    ds = (detail.get("date-started") or {}).get("date")
    de = (detail.get("date-ended") or {}).get("date")

    options = detail.get("options") or {}
    machine = None
    lm_run_id = None

    if isinstance(options, dict):
        machine = options.get("machineName")
        lm_run_id = options.get("lmRunId")

    machine = machine or _parse_opt(argstring, "machineName")
    lm_run_id = lm_run_id or _parse_opt(argstring, "lmRunId")

    return {
        "executionId": execution_id,
        "status": detail.get("status"),
        "project": detail.get("project"),
        "user": detail.get("user"),
        "dateStarted": ds,
        "dateEnded": de,
        "job": {"id": job.get("id"), "name": job.get("name")},
        "machine_name": machine,
        "lmRunId": lm_run_id,
    }

def _start_rundeck_watch(execution_id: int) -> None:
    with RUNDECK_WATCH_LOCK:
        if execution_id in RUNDECK_WATCHING:
            return
        RUNDECK_WATCHING[execution_id] = {"last": None, "errors": 0}

    def _watch():
        try:
            while True:
                try:
                    detail = _rundeck_get_execution_detail(execution_id)
                    payload = _rundeck_detail_to_event(detail, execution_id)

                    status = (payload.get("status") or "").lower()
                    last = RUNDECK_WATCHING.get(execution_id, {}).get("last")

                    if last is None or status != last:
                        BROKER.publish("rundeck_execution", payload)
                        RUNDECK_WATCHING[execution_id]["last"] = status

                    # stop once terminal
                    if status and status not in ("running", "scheduled", "queued"):
                        BROKER.publish("rundeck_execution", payload)
                        break

                    time.sleep(1.5)

                except Exception as e:
                    info = RUNDECK_WATCHING.get(execution_id)
                    if not info:
                        break
                    info["errors"] += 1
                    if info["errors"] >= 12:
                        break
                    time.sleep(2.5)

        finally:
            with RUNDECK_WATCH_LOCK:
                RUNDECK_WATCHING.pop(execution_id, None)

    threading.Thread(target=_watch, daemon=True).start()

app.mount("/static", StaticFiles(directory="/app/static"), name="static")

# --- SECURITY CONFIG ---
# MVP: Load key from env. If missing, generate one (WARNING: ephemeral if not saved!)
# You should add ENCRYPTION_KEY=... to your .env file.
_env_key = get_secret("ENCRYPTION_KEY")
if not _env_key:
    # Generate a key for dev if missing (logs a warning)
    print("WARNING: ENCRYPTION_KEY not found in env. Generating temporary key.")
    _key = Fernet.generate_key()
else:
    _key = _env_key.encode()

cipher_suite = Fernet(_key)

def db():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=get_secret("DB_PASS")
    )

# --- MODELS ---

class CredentialCreate(BaseModel):
    name: str
    type: str  # 'ssh-password' or 'ssh-key'
    username: str
    secret: str

class CredentialRead(BaseModel):
    id: int
    name: str
    type: str
    username: str
    created_at: datetime
    # We purposefully exclude 'secret' from the read model

class LauncherStateUpdate(BaseModel):
    state: Optional[str] = None
    autologon_enabled: Optional[bool] = None
    commissioned: Optional[bool] = None

class AutomationRun(BaseModel):
    machine_name: str
    job_name: str
    status: str
    output: str | None = None
    # New fields to match extended automation_runs schema
    job_type: str | None = None
    step_name: str | None = None
    result: dict | None = None  # structured JSON from jobs

class BulkActionRequest(BaseModel):
    machine_names: List[str]

ALLOWED_ACTIONS = {"commission", "decommission", "start", "stop"}

JOB_CONFIG: Dict[str, Dict[str, str]] = {
    "commission":   {"job_name": "Commission Launcher",   "job_env": "RUNDECK_JOB_COMMISSION_ID"},
    "decommission": {"job_name": "Decommission Launcher", "job_env": "RUNDECK_JOB_DECOMMISSION_ID"},
    "start":        {"job_name": "Start Launcher",        "job_env": "RUNDECK_JOB_START_ID"},
    "stop":         {"job_name": "Stop Launcher",         "job_env": "RUNDECK_JOB_STOP_ID"},
}

BULK_WORKERS = int(os.getenv("BULK_WORKERS", "3"))          # concurrency cap
BULK_DELAY_MS = int(os.getenv("BULK_DELAY_MS", "150"))      # small pacing delay between triggers
JOB_QUEUE: "queue.Queue[dict]" = queue.Queue(maxsize=5000)


def _set_run_failed(lm_run_id: int, machine_name: str, action: str, err: str) -> None:
    # Optional: mark the queued run as failed if we cannot trigger Rundeck at all.
    try:
        with db() as c, c.cursor() as cur:
            cur.execute(
                """
                UPDATE automation_runs
                SET status = %s, output = %s, finished_at = NOW()
                WHERE id = %s
                """,
                ("failed", err[:4000], lm_run_id),
            )
    except Exception:
        pass

    BROKER.publish("automation_run", {
        "machine_name": machine_name,
        "run_id": lm_run_id,
        "job_type": action,
        "status": "failed",
        "step_name": None,
        "result": {"error": err},
    })


def _bulk_worker_loop(worker_id: int) -> None:
    while True:
        job = JOB_QUEUE.get()
        try:
            action = job["action"]
            machine_name = job["machine_name"]
            lm_run_id = job["lm_run_id"]

            cfg = JOB_CONFIG.get(action)
            if not cfg:
                _set_run_failed(lm_run_id, machine_name, action, f"Unknown action '{action}'")
                continue

            job_id = os.getenv(cfg["job_env"])
            if not job_id:
                _set_run_failed(lm_run_id, machine_name, action, f"Missing env var {cfg['job_env']}")
                continue

            # Trigger Rundeck (this is the rate-limited part)
            trigger_rundeck_job(
                job_id,
                options={"machineName": machine_name, "lmRunId": str(lm_run_id)},
            )

            # tiny pacing delay so we don't spike Rundeck even with multiple workers
            if BULK_DELAY_MS > 0:
                time.sleep(BULK_DELAY_MS / 1000.0)

        except Exception as e:
            try:
                _set_run_failed(job.get("lm_run_id"), job.get("machine_name"), job.get("action"), str(e))
            except Exception:
                pass
        finally:
            JOB_QUEUE.task_done()


@app.on_event("startup")
def _start_bulk_workers():
    for i in range(BULK_WORKERS):
        t = threading.Thread(target=_bulk_worker_loop, args=(i,), daemon=True)
        t.start()

# --- RUNDECK HELPER (NEW) ---

def trigger_rundeck_job(job_id: str, options: dict):
    """
    Helper to trigger a Rundeck job with named options.
    """
    # UPDATED LINE:
    token = get_secret("RUNDECK_TOKEN")
    url = os.getenv("RUNDECK_URL")

    if not url or not token:
        raise HTTPException(status_code=500, detail="Rundeck URL or token not configured")
    if not job_id:
        raise HTTPException(status_code=500, detail="Rundeck job ID not configured")

    try:
        r = requests.post(
            f"{url}/api/54/job/{job_id}/run",
            headers={
                "X-Rundeck-Auth-Token": token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={"options": options},
            timeout=30,
            verify=False,
        )
        r.raise_for_status()
        execution = r.json()

        # Rundeck response usually contains {"id": <executionId>}
        ex_id = execution.get("id") or (execution.get("execution") or {}).get("id")
        try:
            ex_id_int = int(ex_id) if ex_id is not None else None
        except Exception:
            ex_id_int = None

        if ex_id_int:
            BROKER.publish("rundeck_execution", {
                "executionId": ex_id_int,
                "status": "running",
                "machine_name": options.get("machineName"),
                "lmRunId": options.get("lmRunId"),
            })
            _start_rundeck_watch(ex_id_int)

        return execution

    except requests.HTTPError as e:
        # include body to make debugging easier
        body = ""
        try:
            body = e.response.text
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"Rundeck HTTP error: {e} {body}")

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rundeck error: {e}")

def _enqueue_action(machine_name: str, action: str) -> int:
    if action not in ALLOWED_ACTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported action '{action}'")

    cfg = JOB_CONFIG[action]

    # Create "queued" run row and publish SSE event
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO automation_runs (machine_name, job_name, job_type, status)
            VALUES (%s, %s, %s, %s)
            RETURNING id
            """,
            (machine_name, cfg["job_name"], action, "queued"),
        )
        lm_run_id = cur.fetchone()["id"]

    BROKER.publish("automation_run", {
        "machine_name": machine_name,
        "run_id": lm_run_id,
        "job_type": action,
        "status": "queued",
        "step_name": None,
    })

    JOB_QUEUE.put({
        "action": action,
        "machine_name": machine_name,
        "lm_run_id": lm_run_id,
    })

    return lm_run_id

# --- ROUTES ---
@app.delete("/api/launchers/{machine_name}")
def delete_launcher(machine_name: str):
    """
    Permanently removes a launcher record.
    """
    try:
        with db() as c, c.cursor() as cur:
            # 1. Clean up group memberships first (FK constraints)
            cur.execute("DELETE FROM launcher_group_members WHERE machine_name = %s", (machine_name,))
            
            # 2. Delete launcher
            cur.execute("DELETE FROM launchers WHERE machine_name = %s RETURNING machine_name", (machine_name,))
            row = cur.fetchone()
            
            if not row:
                raise HTTPException(status_code=404, detail="Launcher not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {e}")

    return {"ok": True, "deleted": machine_name}
    
@app.post("/api/groups/{group_id}/{action}")
def run_group_action(group_id: str, action: str):
    if action not in ALLOWED_ACTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported action '{action}'")

    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT id, name FROM launcher_groups WHERE id = %s", (group_id,))
        g = cur.fetchone()
        if not g:
            raise HTTPException(status_code=404, detail="Group not found")

        cur.execute(
            """
            SELECT l.machine_name, l.managed_policy_id, l.credential_id
            FROM launcher_group_members gm
            JOIN launchers l
              ON l.machine_name = gm.machine_name
            WHERE gm.group_id = %s
            ORDER BY l.machine_name
            """,
            (group_id,),
        )
        rows = cur.fetchall()

    queued = []
    skipped = []

    for r in rows:
        mn = r["machine_name"]

        if action == "commission":
            if r.get("managed_policy_id") is None:
                skipped.append({"machine_name": mn, "reason": "Missing managed_policy_id"})
                continue
            if r.get("credential_id") is None:
                skipped.append({"machine_name": mn, "reason": "Missing credential_id"})
                continue

        run_id = _enqueue_action(mn, action)
        queued.append({"machine_name": mn, "automationRunId": run_id})

    return {"group_id": group_id, "group_name": g["name"], "action": action, "queued": queued, "skipped": skipped}

@app.get("/api/groups")
def list_groups():
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT
              g.id,
              g.name,
              g.type,
              COUNT(DISTINCT l.machine_name)::int AS member_count,
              g.description,
              g.last_synced_at
            FROM launcher_groups g
            LEFT JOIN launcher_group_members gm
              ON gm.group_id = g.id
            LEFT JOIN launchers l
              ON lower(l.machine_name) = lower(gm.machine_name)
            GROUP BY g.id, g.name, g.type, g.description, g.last_synced_at
            ORDER BY g.name
            """
        )
        return cur.fetchall()

@app.get("/api/groups/{group_id}")
def get_group(group_id: str):
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, name, type, member_count, description, last_synced_at
            FROM launcher_groups
            WHERE id = %s
            """,
            (group_id,),
        )
        g = cur.fetchone()
        if not g:
            raise HTTPException(status_code=404, detail="Group not found")

        cur.execute(
            """
            SELECT
              l.machine_name, l.ip_address, l.online, l.properties, l.first_seen,
              l.autologon_enabled, l.secure_launcher_enabled, l.current_version,
              l.managed_policy_id, l.credential_id
            FROM launcher_group_members gm
            JOIN launchers l
              ON l.machine_name = gm.machine_name
            WHERE gm.group_id = %s
            ORDER BY l.machine_name
            """,
            (group_id,),
        )
        members = cur.fetchall()

    return {"group": g, "members": members}

@app.post("/api/launchers/bulk/{action}")
def bulk_launcher_action(action: str, body: BulkActionRequest):
    if action not in ALLOWED_ACTIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported action '{action}'")

    names = [n.strip() for n in (body.machine_names or []) if isinstance(n, str) and n.strip()]
    # de-dupe
    names = list(dict.fromkeys(names))

    if not names:
        raise HTTPException(status_code=400, detail="machine_names is required")

    # Fetch launchers once for validation
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT machine_name, managed_policy_id, credential_id
            FROM launchers
            WHERE machine_name = ANY(%s)
            """,
            (names,),
        )
        rows = cur.fetchall()

    found = {r["machine_name"]: r for r in rows}
    queued = []
    skipped = []

    for mn in names:
        row = found.get(mn)
        if not row:
            skipped.append({"machine_name": mn, "reason": "Launcher not found"})
            continue

        if action == "commission":
            if row.get("managed_policy_id") is None:
                skipped.append({"machine_name": mn, "reason": "Missing managed_policy_id"})
                continue
            if row.get("credential_id") is None:
                skipped.append({"machine_name": mn, "reason": "Missing credential_id"})
                continue

        run_id = _enqueue_action(mn, action)
        queued.append({"machine_name": mn, "automationRunId": run_id})

    return {"action": action, "queued": queued, "skipped": skipped}

@app.get("/api/events")
async def sse_events(request: Request):
    client_id, q = BROKER.subscribe()

    async def gen():
        # tell browser how long to wait before reconnecting
        yield b"retry: 2000\n\n"

        last_ping = time.monotonic()
        try:
            while True:
                if await request.is_disconnected():
                    break

                try:
                    # wait up to 1s for an event (in a thread so we don't block the loop)
                    msg = await anyio.to_thread.run_sync(lambda: q.get(timeout=1))
                    yield _sse(msg["event"], msg["data"])
                except queue.Empty:
                    # keep-alive comment every ~15s (helps proxies keep the stream open)
                    if time.monotonic() - last_ping > 15:
                        yield b": keepalive\n\n"
                        last_ping = time.monotonic()
        finally:
            BROKER.unsubscribe(client_id)

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        # If you ever sit behind nginx, this header disables response buffering. :contentReference[oaicite:4]{index=4}
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)

@app.get("/", response_class=HTMLResponse)
async def root():
    return open("/app/static/index.html").read()

@app.get("/ui", response_class=HTMLResponse)
async def ui():
    return open("/app/static/index.html").read()

@app.get("/api/launchers")
def list_launchers():
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        # Updated to include new SSH columns
        cur.execute(
            """
            SELECT machine_name, ip_address, online, commissioned, source, managed_policy_id, 
                   ssh_host, ssh_port, credential_id, properties, first_seen, autologon_enabled, 
                   secure_launcher_enabled, sessions, current_version
            FROM launchers 
            ORDER BY machine_name
            """
        )
        return cur.fetchall()

# --- GET SINGLE LAUNCHER ---

@app.get("/api/launchers/{machine_name}")
def get_launcher(machine_name: str):
    """
    Returns a single launcher record including SSH + policy linkage.
    Used by UI and automation for ad-hoc inspection.
    """
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT machine_name,
                   ip_address,
                   online,
                   source,
                   managed_policy_id,
                   ssh_host,
                   ssh_port,
                   credential_id,
                   properties,
                   groups,
                   last_synced_at,
                   last_state_change
            FROM launchers
            WHERE machine_name = %s
            """,
            (machine_name,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Launcher not found")
        return row

# --- CREDENTIAL ROUTES ---

@app.get("/api/credentials", response_model=List[CredentialRead])
def list_credentials():
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT id, name, type, username, created_at FROM credentials ORDER BY id")
        return cur.fetchall()

@app.delete("/api/credentials/{credential_id}")
def delete_credential(credential_id: int):
    """
    Deletes a credential.
    Only allowed if the credential is NOT assigned to any launcher.
    """
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:

        # Prevent deleting credentials in use
        cur.execute(
            "SELECT COUNT(*) FROM launchers WHERE credential_id = %s",
            (credential_id,)
        )
        in_use = cur.fetchone()["count"]

        if in_use > 0:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete credential: it is assigned to one or more launchers."
            )

        # Delete credential
        cur.execute(
            "DELETE FROM credentials WHERE id = %s RETURNING id",
            (credential_id,)
        )
        row = cur.fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Credential not found")

        return {"ok": True, "deletedId": row["id"]}

@app.get("/api/policies")
def list_policies():
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT id, name FROM launcher_policies ORDER BY id"
        )
        return cur.fetchall()

@app.get("/api/policies/{policy_id}")
def get_policy(policy_id: int):
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT id, name, policy FROM launcher_policies WHERE id = %s",
            (policy_id,)
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Policy not found")
        return row

@app.post("/api/credentials", response_model=CredentialRead)
def create_credential(cred: CredentialCreate):
    # Encrypt the secret before storing
    encrypted_secret = cipher_suite.encrypt(cred.secret.encode()).decode()
    
    try:
        with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO credentials (name, type, username, secret)
                VALUES (%s, %s, %s, %s)
                RETURNING id, name, type, username, created_at
                """,
                (cred.name, cred.type, cred.username, encrypted_secret)
            )
            new_cred = cur.fetchone()
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=400, detail="Credential name must be unique")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
        
    return new_cred

# --- REGISTER ROUTE ---

@app.post("/api/launchers/register")
def register(
    machineName: str = Form(...),
    ipAddress: str = Form(...),
    domain: str = Form(""),
    username: str = Form(""),
    notes: str = Form(""),
    # New SSH Fields (Optional)
    sshHost: Optional[str] = Form(None),
    sshPort: int = Form(22),
    credentialId: Optional[int] = Form(None),
    # New: optional managed policy association
    managedPolicyId: Optional[int] = Form(None),
):
    with db() as c, c.cursor() as cur:
        cur.execute(
            """
            INSERT INTO launchers (
                machine_name, ip_address, online, source, 
                properties, last_synced_at,
                ssh_host, ssh_port, credential_id, managed_policy_id
            )
            VALUES (
                %s, %s, false, 'manual',
                jsonb_build_object('domain', %s, 'username', %s, 'notes', %s), now(),
                %s, %s, %s, %s
            )
            ON CONFLICT (machine_name) DO UPDATE
            SET ip_address       = EXCLUDED.ip_address,
                source           = 'manual',
                properties       = EXCLUDED.properties,
                last_synced_at   = now(),
                ssh_host         = EXCLUDED.ssh_host,
                ssh_port         = EXCLUDED.ssh_port,
                credential_id    = COALESCE(EXCLUDED.credential_id, launchers.credential_id),
                managed_policy_id= COALESCE(EXCLUDED.managed_policy_id, launchers.managed_policy_id)
            """,
            (machineName, ipAddress, domain, username, notes,
             sshHost, sshPort, credentialId, managedPolicyId),
        )
    return {"ok": True}

@app.post("/api/launchers/import")
async def import_launchers(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a .csv file")

    raw = await file.read()
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))

    def norm(s: str) -> str:
        return "".join(ch for ch in (s or "").strip().lower() if ch.isalnum())

    # Expect these logical columns (flexible header names)
    # Expect these logical columns (flexible header names)
    col_map = {}
    for h in (reader.fieldnames or []):
        nh = norm(h)
        if nh in ("machinename", "machine", "machinenameid", "machine_name"):
            col_map["machine_name"] = h
        elif nh in ("ipaddress", "ip", "ip_address"):
            col_map["ip_address"] = h
        elif nh in ("credential", "credentialid", "credential_id"):
            col_map["credential_id"] = h
        # support: Policy / Policy ID / managed_policy_id / managedPolicyId
        elif nh in ("policy", "policyid", "managedpolicy", "managedpolicyid", "managed_policy_id"):
            col_map["managed_policy_id"] = h

    missing = [k for k in ("machine_name", "ip_address") if k not in col_map]
    if missing:
        raise HTTPException(status_code=400, detail=f"CSV missing required columns: {', '.join(missing)}")

    parsed = []
    skipped = []

    for i, row in enumerate(reader, start=2):  # 2 = header is line 1
        mn = (row.get(col_map["machine_name"]) or "").strip()
        ip = (row.get(col_map["ip_address"]) or "").strip()
        cred_raw = (row.get(col_map["credential_id"]) or "").strip()
        pol_raw = (row.get(col_map["managed_policy_id"]) or "").strip()

        if not mn or not ip or not cred_raw or not pol_raw:
            skipped.append({"line": i, "machine_name": mn or None, "reason": "Missing required value"})
            continue

        try:
            cred_id = int(cred_raw)
            pol_id = int(pol_raw)
        except Exception:
            skipped.append({"line": i, "machine_name": mn, "reason": "Credential/Policy must be numeric IDs"})
            continue

        parsed.append((mn, ip, cred_id, pol_id))

    if not parsed:
        return {"inserted": 0, "updated": 0, "skipped": skipped}

    # Validate IDs exist (one pass)
    cred_ids = sorted({p[2] for p in parsed})
    pol_ids = sorted({p[3] for p in parsed})

    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT id FROM credentials WHERE id = ANY(%s)", (cred_ids,))
        valid_creds = {r["id"] for r in cur.fetchall()}

        cur.execute("SELECT id FROM launcher_policies WHERE id = ANY(%s)", (pol_ids,))
        valid_pols = {r["id"] for r in cur.fetchall()}

    inserted = 0
    updated = 0

    with db() as c, c.cursor() as cur:
        for (mn, ip, cred_id, pol_id) in parsed:
            if cred_id not in valid_creds:
                skipped.append({"machine_name": mn, "reason": f"Credential ID {cred_id} not found"})
                continue
            if pol_id not in valid_pols:
                skipped.append({"machine_name": mn, "reason": f"Policy ID {pol_id} not found"})
                continue

            try:
                cur.execute(
                    """
                    INSERT INTO launchers (
                        machine_name, ip_address, online, source,
                        properties, last_synced_at,
                        ssh_host, ssh_port,
                        credential_id, managed_policy_id
                    )
                    VALUES (
                        %s, %s, false, 'csv',
                        '{}'::jsonb, now(),
                        %s, 22,
                        %s, %s
                    )
                    ON CONFLICT (machine_name) DO UPDATE
                    SET ip_address        = EXCLUDED.ip_address,
                        source            = 'csv',
                        last_synced_at    = now(),
                        ssh_host          = EXCLUDED.ssh_host,
                        ssh_port          = EXCLUDED.ssh_port,
                        credential_id     = COALESCE(EXCLUDED.credential_id, launchers.credential_id),
                        managed_policy_id = COALESCE(EXCLUDED.managed_policy_id, launchers.managed_policy_id)
                    RETURNING (xmax = 0) AS inserted
                    """,
                    (mn, ip, ip, cred_id, pol_id),
                )
                was_inserted = cur.fetchone()[0]
                if was_inserted:
                    inserted += 1
                else:
                    updated += 1
            except Exception as e:
                skipped.append({"machine_name": mn, "reason": f"DB error: {str(e)}"})

    return {"inserted": inserted, "updated": updated, "skipped": skipped}

# --- POLICY RESOLVER FOR A LAUNCHER ---

@app.get("/api/launchers/{machine_name}/policy")
def get_launcher_policy(machine_name: str):
    """
    Returns the effective policy JSON for a launcher, based on managed_policy_id.
    """
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT lp.policy
            FROM launchers l
            JOIN launcher_policies lp
              ON l.managed_policy_id = lp.id
            WHERE l.machine_name = %s
            """,
            (machine_name,),
        )
        row = cur.fetchone()
        if not row:
            # Either launcher missing or managed_policy_id not set / invalid
            raise HTTPException(status_code=404, detail="Policy not found for launcher")
        return row["policy"]

# --- COMBINED RESOLVER FOR RUNDECK ---

@app.get("/api/automation/resolve/{machine_name}")
def resolve_for_automation(machine_name: str):
    """
    Single endpoint for Rundeck:
    - Resolves launcher SSH connection details
    - Resolves credential (including decrypted secret)
    - Resolves effective policy
    - Includes LE_FQDN so Rundeck jobs never rely on container env
    """
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT
              l.machine_name,
              COALESCE(l.ssh_host, l.ip_address::text) AS ssh_host,
              l.ssh_port,
              l.managed_policy_id,
              c.id          AS credential_id,
              c.username    AS cred_username,
              c.secret      AS cred_secret,
              c.type        AS cred_type,
              lp.policy     AS policy
            FROM launchers l
            LEFT JOIN credentials c
              ON l.credential_id = c.id
            LEFT JOIN launcher_policies lp
              ON l.managed_policy_id = lp.id
            WHERE l.machine_name = %s
            """,
            (machine_name,),
        )
        row = cur.fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Launcher not found")

        if row["credential_id"] is None or row["cred_secret"] is None:
            raise HTTPException(
                status_code=400,
                detail="Launcher is missing an associated credential"
            )

        # decrypt credential
        try:
            secret_plain = cipher_suite.decrypt(row["cred_secret"].encode()).decode()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to decrypt credential: {e}")

        ssh_host = row["ssh_host"]
        ssh_port = row["ssh_port"] or 22

        policy = row["policy"] if row["policy"] is not None else {}

        le_fqdn = os.getenv("LE_FQDN")
        le_ssh_user = os.getenv("LE_SSH_USER")
        le_ssh_pass = get_secret("LE_SSH_PASS")
        le_api_token = get_secret("LE_API_TOKEN")
        
        lm_ssh_user = os.getenv("LM_SSH_USER")
        lm_ssh_pass = get_secret("LM_SSH_PASS")
        lm_fqdn = os.getenv("LM_FQDN")

        if not le_fqdn or not le_ssh_user or not le_ssh_pass:
            raise HTTPException(status_code=500, detail="LE appliance SSH environment variables missing")

        return {
            "machine_name": row["machine_name"],
            "ssh": {
                "host": ssh_host,
                "port": ssh_port,
                "username": row["cred_username"],
                "secret": secret_plain,
                "type": row["cred_type"],
            },
            "policy": policy,
            "le_appliance": {
                "fqdn": le_fqdn,
                "ssh_user": le_ssh_user,
                "ssh_pass": le_ssh_pass,
                "api_token": le_api_token,
                "lm_fqdn": lm_fqdn,
                "lm_ssh_user": lm_ssh_user,
                "lm_ssh_pass": lm_ssh_pass
            }        
        }

# --- EXISTING ROUTES (UNCHANGED LOGIC) ---

@app.get("/api/le-version")
def get_le_version():
    LE_FQDN = os.getenv("LE_FQDN")
    LE_API_TOKEN = get_secret("LE_API_TOKEN")

    if not LE_FQDN or not LE_API_TOKEN:
        raise HTTPException(status_code=500, detail="LE_FQDN or LE_API_TOKEN is not configured")

    url = f"https://{LE_FQDN}/publicApi/v7/system/version"

    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {LE_API_TOKEN}"},
            verify=False,
            timeout=10
        )
        resp.raise_for_status()
        data = resp.json()
        version = data.get("currentVersion")
        if not version:
            raise HTTPException(status_code=502, detail="system/version response missing 'version'")
        return {"version": version}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to retrieve LE version: {e}" )

@app.post("/api/launchers/{machine_name}/state")
def update_launcher_state(machine_name: str, body: LauncherStateUpdate):
    updates = []
    params = []

    # Flag to track if we are wiping data (Decommissioning)
    is_decommissioning = (body.commissioned is False)

    # 1. Handle 'state' update
    if body.state is not None:
        valid_states = {"running", "stopped", "compliant", "offline"}
        if body.state not in valid_states:
            raise HTTPException(status_code=400, detail=f"Invalid state '{body.state}'")
        
        # Update 'online' column
        updates.append("online = CASE WHEN %s = 'running' THEN TRUE ELSE FALSE END")
        params.append(body.state)
        
        # ONLY update specific JSON property if we are NOT about to wipe it entirely
        if not is_decommissioning:
            updates.append("""
                properties = jsonb_set(
                    COALESCE(properties, '{}'::jsonb),
                    '{state}',
                    to_jsonb(%s::text)
                )
            """)
            params.append(body.state)

    # 2. Handle 'autologon_enabled'
    if body.autologon_enabled is not None:
        updates.append("autologon_enabled = %s")
        params.append(body.autologon_enabled)

    # 3. Handle 'commissioned'
    if body.commissioned is not None:
        updates.append("commissioned = %s")
        params.append(body.commissioned)

        # If Decommissioning: WIPE DATA
        if is_decommissioning:
            # Overwrite properties with empty JSON (wins over the json_set above)
            updates.append("properties = '{}'::jsonb") 
            updates.append("current_version = NULL")
            updates.append("supported_version = NULL")
            updates.append("first_seen = NULL")
            updates.append("sessions = 0")
            # We already handled 'online' via the state check above, or we can force it here:
            if body.state is None:
                 updates.append("online = FALSE")

    if not updates:
        return {"machine_name": machine_name, "message": "No changes requested"}

    updates.append("last_synced_at = NOW()")

    sql = f"UPDATE launchers SET {', '.join(updates)} WHERE machine_name = %s"
    params.append(machine_name)

    try:
        with db() as c, c.cursor() as cur:
            cur.execute(sql, tuple(params))
    except Exception as e:
        # Log the error so you can see it in docker logs if it happens again
        print(f"DB Error in update_launcher_state: {e}")
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
    
    if body.state:
        BROKER.publish("launcher_state", {
            "machine_name": machine_name,
            "state": body.state,
            "online": True if body.state == "running" else False,
        })

    return {"machine_name": machine_name, "updated": body.dict(exclude_unset=True)}
# --- AUTOMATION RUNS ENDPOINT TO USE NEW COLUMNS ---
@app.post("/api/automation/runs")
def record_automation_run(run: AutomationRun):
    """
    Records an automation run result.
    Now supports job_type, step_name, and structured result JSON.
    """
    try:
        with db() as c, c.cursor() as cur:
            cur.execute(
                """
                INSERT INTO automation_runs (
                    machine_name,
                    job_name,
                    status,
                    output,
                    finished_at,
                    job_type,
                    step_name,
                    result
                )
                VALUES (%s, %s, %s, %s, NOW(), %s, %s, %s)
                """,
                (
                    run.machine_name,
                    run.job_name,
                    run.status,
                    run.output,
                    run.job_type,
                    run.step_name,
                    Json(run.result) if run.result is not None else None,
                ),
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {e}")
   
    BROKER.publish("automation_run", {
        "machine_name": run.machine_name,
        "job_type": run.job_type,
        "status": run.status,          # success / failed / running
        "step_name": run.step_name,
        "result": run.result,
        }
    )
    
    return {"ok": True, "recorded": run.dict()}

@app.post("/api/policies")
def upload_policy(name: str = Form(...), file: UploadFile = File(...)):
    try:
        policy = json.loads(file.file.read().decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO launcher_policies(name, policy) VALUES(%s, %s) RETURNING id",
            (name, json.dumps(policy)),
        )
        r = cur.fetchone()
        return {"id": r["id"]}

@app.delete("/api/policies/{policy_id}")
def delete_policy(policy_id: int):
    """
    Deletes a launcher policy.
    Only allowed if the policy is NOT actively assigned to any launcher.
    """
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:

        # Prevent deleting policies in use
        cur.execute(
            "SELECT COUNT(*) FROM launchers WHERE managed_policy_id = %s",
            (policy_id,)
        )
        in_use = cur.fetchone()["count"]
        if in_use > 0:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete policy: it is assigned to one or more launchers."
            )

        # Delete policy
        cur.execute(
            "DELETE FROM launcher_policies WHERE id = %s RETURNING id",
            (policy_id,)
        )
        row = cur.fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Policy not found")

        return {"ok": True, "deletedId": row["id"]}


# --- COMMISSION / DECOMMISSION / START / STOP ENDPOINTS ---

@app.post("/api/launchers/{machine_name}/commission")
def commission_launcher(machine_name: str):
    """
    Kick off a Commission Launcher job via the Queue.
    Validates pre-requisites before queuing.
    """
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        # Validate launcher existence and config
        cur.execute(
            """
            SELECT machine_name, managed_policy_id, credential_id
            FROM launchers
            WHERE machine_name = %s
            """,
            (machine_name,),
        )
        launcher = cur.fetchone()

        if not launcher:
            raise HTTPException(status_code=404, detail="Launcher not found")

        if launcher["managed_policy_id"] is None:
            raise HTTPException(status_code=400, detail="Launcher has no managed_policy_id set")

        if launcher["credential_id"] is None:
            raise HTTPException(status_code=400, detail="Launcher has no credential_id set")

    # Enqueue (Handles DB insert, SSE, and Queue put)
    try:
        lm_run_id = _enqueue_action(machine_name, "commission")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to enqueue commission job: {e}")

    return {
        "status": "queued",
        "machineName": machine_name,
        "automationRunId": lm_run_id,
        "message": "Commission job queued successfully"
    }

@app.post("/api/launchers/{machine_name}/decommission")
def decommission_launcher(machine_name: str):
    """
    Kick off a Decommission Launcher job via the Queue.
    """
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT machine_name FROM launchers WHERE machine_name = %s",
            (machine_name,),
        )
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Launcher not found")

    try:
        lm_run_id = _enqueue_action(machine_name, "decommission")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to enqueue decommission job: {e}")

    return {
        "status": "queued",
        "machineName": machine_name,
        "automationRunId": lm_run_id,
        "message": "Decommission job queued successfully"
    }

@app.post("/api/launchers/{machine_name}/start")
def start_launcher(machine_name: str):
    """
    Kick off a Start Launcher job via the Queue.
    """
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT machine_name FROM launchers WHERE machine_name = %s",
            (machine_name,),
        )
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Launcher not found")

    try:
        lm_run_id = _enqueue_action(machine_name, "start")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to enqueue start job: {e}")

    return {
        "status": "queued",
        "machineName": machine_name,
        "automationRunId": lm_run_id,
        "message": "Start job queued successfully"
    }

@app.post("/api/launchers/{machine_name}/stop")
def stop_launcher(machine_name: str):
    """
    Kick off a Stop Launcher job via the Queue.
    """
    with db() as c, c.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT machine_name FROM launchers WHERE machine_name = %s",
            (machine_name,),
        )
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Launcher not found")

    try:
        lm_run_id = _enqueue_action(machine_name, "stop")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to enqueue stop job: {e}")

    return {
        "status": "queued",
        "machineName": machine_name,
        "automationRunId": lm_run_id,
        "message": "Stop job queued successfully"
    }