\connect le_mgr

-- ============================================================
-- Login Enterprise Launcher Manager (LM) - Production Schema
-- ============================================================
-- Initializes ONLY the LM application tables.
-- Rundeck and n8n manage their own schemas/tables separately.
--
-- Notes:
-- - Idempotent for first-boot initialization.
-- - Includes PKs, FKs, and indexes used by LM.
-- ============================================================

BEGIN;

-- -------------------------
-- Credentials
-- -------------------------
CREATE TABLE IF NOT EXISTS public.credentials (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    type        TEXT NOT NULL CHECK (type IN ('ssh-password','ssh-key')),
    username    TEXT NOT NULL,
    secret      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------
-- Launcher Policies
-- -------------------------
CREATE TABLE IF NOT EXISTS public.launcher_policies (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    policy      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------
-- Launchers (inventory)
-- -------------------------
CREATE TABLE IF NOT EXISTS public.launchers (
    machine_name            TEXT PRIMARY KEY,
    ip_address              INET,
    online                  BOOLEAN,
    source                  TEXT DEFAULT 'le-api',
    managed_policy_id       INTEGER,

    -- SSH / credential linkage
    ssh_host                TEXT,
    ssh_port                INTEGER DEFAULT 22,
    credential_id           BIGINT,

    -- Inventory / metadata from LE API
    properties              JSONB,
    first_seen              TIMESTAMPTZ,
    supported_version       BOOLEAN,
    sessions                INTEGER,
    current_version         BOOLEAN,
    autologon_enabled       BOOLEAN,
    secure_launcher_enabled BOOLEAN,
    location_id             INTEGER,
    last_synced_at          TIMESTAMPTZ DEFAULT now(),
    last_state_change       TIMESTAMPTZ,
    groups                  JSONB,

    -- Observed state (Step 8.3.2)
    last_commissioned_at    TIMESTAMPTZ,
    launcher_version        TEXT,
    uwc_bundle_version      TEXT,

    -- Commissioned flag (UI + automation)
    commissioned            BOOLEAN DEFAULT false,

    CONSTRAINT launchers_credential_id_fkey
        FOREIGN KEY (credential_id)
        REFERENCES public.credentials(id)
        ON DELETE SET NULL
);

-- Indexes for Launchers
CREATE INDEX IF NOT EXISTS idx_launchers_online
    ON public.launchers (online);

CREATE INDEX IF NOT EXISTS idx_launchers_commissioned
    ON public.launchers (commissioned);

CREATE INDEX IF NOT EXISTS idx_launchers_props
    ON public.launchers USING GIN (properties);

CREATE INDEX IF NOT EXISTS idx_launchers_groups
    ON public.launchers USING GIN (groups);

-- Optional (helpful) indexes for common lookups/joins
CREATE INDEX IF NOT EXISTS idx_launchers_credential_id
    ON public.launchers (credential_id);

CREATE INDEX IF NOT EXISTS idx_launchers_managed_policy_id
    ON public.launchers (managed_policy_id);

-- -------------------------
-- Launcher Groups (mirrors LE launcher group IDs)
-- -------------------------
CREATE TABLE IF NOT EXISTS public.launcher_groups (
    id             UUID PRIMARY KEY,
    name           TEXT NOT NULL,
    type           TEXT,
    filter         TEXT,
    members        JSONB,
    member_count   INTEGER,
    description    TEXT,
    last_synced_at TIMESTAMPTZ DEFAULT now(),
    created        TIMESTAMPTZ,
    last_modified  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lg_name
    ON public.launcher_groups (name);

CREATE INDEX IF NOT EXISTS idx_lg_type
    ON public.launcher_groups (type);

CREATE INDEX IF NOT EXISTS idx_lg_members
    ON public.launcher_groups USING GIN (members);

-- -------------------------
-- Group membership (many-to-many)
-- -------------------------
CREATE TABLE IF NOT EXISTS public.launcher_group_members (
    group_id     UUID NOT NULL,
    machine_name TEXT NOT NULL,
    added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, machine_name),
    CONSTRAINT launcher_group_members_group_id_fkey
        FOREIGN KEY (group_id)
        REFERENCES public.launcher_groups(id)
        ON DELETE CASCADE,
    CONSTRAINT launcher_group_members_machine_name_fkey
        FOREIGN KEY (machine_name)
        REFERENCES public.launchers(machine_name)
        ON DELETE CASCADE
);

-- Helpful for reverse lookups: "which groups is this launcher in?"
CREATE INDEX IF NOT EXISTS idx_launcher_group_members_machine_name
    ON public.launcher_group_members (machine_name);

-- -------------------------
-- Sync Runs (inventory/sync tracking)
-- -------------------------
CREATE TABLE IF NOT EXISTS public.sync_runs (
    id          BIGSERIAL PRIMARY KEY,
    source      VARCHAR(64) NOT NULL,
    started_at  TIMESTAMPTZ DEFAULT now(),
    finished_at TIMESTAMPTZ,
    status      TEXT,
    details     JSONB
);

-- -------------------------
-- Automation Runs (Rundeck execution tracking)
-- -------------------------
CREATE TABLE IF NOT EXISTS public.automation_runs (
    id           BIGSERIAL PRIMARY KEY,
    machine_name TEXT NOT NULL,
    job_name     TEXT NOT NULL,
    status       TEXT NOT NULL,
    output       TEXT,
    finished_at  TIMESTAMPTZ DEFAULT now(),
    job_type     TEXT,
    step_name    TEXT,
    result       JSONB
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_machine
    ON public.automation_runs (machine_name);

CREATE INDEX IF NOT EXISTS idx_automation_runs_job
    ON public.automation_runs (job_name);

CREATE INDEX IF NOT EXISTS idx_automation_runs_job_type
    ON public.automation_runs (job_type);

CREATE INDEX IF NOT EXISTS idx_automation_runs_step_name
    ON public.automation_runs (step_name);

COMMIT;
