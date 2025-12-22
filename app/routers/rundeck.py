# /app/routers/rundeck.py
import os
import re
from fastapi import APIRouter, Query, HTTPException
from services.rundeck_client import RundeckClient

router = APIRouter(prefix="/api/rundeck", tags=["rundeck"])

def _client():
    return RundeckClient()

def _job_ids():
    ids = [
        os.getenv("RUNDECK_JOB_COMMISSION_ID"),
        os.getenv("RUNDECK_JOB_DECOMMISSION_ID"),
        os.getenv("RUNDECK_JOB_START_ID"),
        os.getenv("RUNDECK_JOB_STOP_ID"),
    ]
    return [j for j in ids if j]

def _parse_opt(argstring: str | None, opt: str) -> str | None:
    if not argstring:
        return None
    s = str(argstring)
    m = re.search(rf"(?:^|\s)-{re.escape(opt)}(?:=|\s+)(\S+)", s, flags=re.IGNORECASE)
    return m.group(1) if m else None

@router.get("/executions")
def list_executions(
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """
    Aggregated run history across LM-managed Rundeck jobs.
    Pagination is applied AFTER merge + sort.
    """
    c = _client()
    job_ids = _job_ids()
    if not job_ids:
        raise HTTPException(status_code=500, detail="No Rundeck job IDs configured.")

    merged: list[dict] = []
    per_job_fetch = min(limit * 2, 100)

    for job_id in job_ids:
        data = c.job_executions(job_id, max=per_job_fetch, offset=0) or {}
        executions = data.get("executions") or []

        for ex in executions:
            argstring = ex.get("argstring") or ""
            merged.append({
                "executionId": ex.get("id"),
                "status": ex.get("status"),
                "project": ex.get("project"),
                "user": ex.get("user"),
                "dateStarted": (ex.get("date-started") or {}).get("date"),
                "dateEnded": (ex.get("date-ended") or {}).get("date"),
                "argstring": argstring,
                # helpful derived fields so UI doesn’t need to regex
                "machineName": _parse_opt(argstring, "machineName"),
                "lmRunId": _parse_opt(argstring, "lmRunId"),
                "job": {
                    "id": (ex.get("job") or {}).get("id"),
                    "name": (ex.get("job") or {}).get("name"),
                },
            })

    merged.sort(key=lambda x: x.get("dateStarted") or "", reverse=True)
    total = len(merged)
    page = merged[offset: offset + limit]

    return {"items": page, "limit": limit, "offset": offset, "total": total}

@router.get("/executions/{execution_id}")
def get_execution(execution_id: int):
    c = _client()
    return c.execution_detail(execution_id)

@router.get("/executions/{execution_id}/output")
def get_execution_output(
    execution_id: int,
    offset: int = Query(0, ge=0),
    lastmod: int = Query(0, ge=0),
):
    c = _client()
    return c.execution_output(execution_id, offset=offset, lastmod=lastmod)
