'use strict';

// Postgres schema for the reimbursement portal. Each statement is run
// individually (Neon's HTTP driver executes one statement per call).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('superadmin','admin','manager','lowmgmt','finance','employee')),
    department    TEXT NOT NULL DEFAULT '',
    position      TEXT NOT NULL DEFAULT '',
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Backfill the position column for databases created before it existed.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS position TEXT NOT NULL DEFAULT ''`,
  // Bank / payout details live on the account (entered when the account is
  // registered), not on each claim.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS recipient_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_account_no TEXT NOT NULL DEFAULT ''`,
  // Email address for the account. Used for password-reset links and workflow
  // notifications (submissions to approve, rejections). Stored lower-cased.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`,
  // Preferred UI language (BCP-47-ish short code: 'en','id','th','vi','km','fil').
  // Set when a user picks a language from the switcher; it becomes their default
  // and follows the account across devices. Defaults to English.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'`,
  // Region the account belongs to (a regions.name value, or '*' = All regions).
  // Data outside the account's region is hidden; super admins and '*' accounts
  // see everything. Existing super admins get '*' so they keep full visibility.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT ''`,
  `UPDATE users SET region = '*' WHERE role = 'superadmin' AND region = ''`,
  // Role model: six codes mapped to the org's roles —
  //   superadmin → Super Admin      admin    → Country Manager / Managing Director
  //   manager    → Mid Management    lowmgmt  → Low Management
  //   finance    → Finance           employee → Employee
  // Their powers are configured in the region-scoped role-permission matrix.
  // The legacy generic 'user' role is retired: fold it into 'employee' (the new
  // baseline), then widen the CHECK to the six-code set and normalise any value
  // still outside it to 'employee'. NOTE: we deliberately do NOT remap
  // 'admin' → 'superadmin' here — 'admin' is a real role (Country Manager / MD),
  // and an idempotent remap would clobber those accounts on every boot.
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
  `UPDATE users SET role = 'employee' WHERE role = 'user'`,
  `UPDATE users SET role = 'employee' WHERE role NOT IN ('superadmin','admin','manager','lowmgmt','finance','employee')`,
  `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin','admin','manager','lowmgmt','finance','employee'))`,
  // Per-account approval limit: the largest claim amount (in cents, matching
  // claims.amount_cents / meal_claims.total_cents) this account may approve. NULL
  // means unlimited — the default, so existing accounts keep approving any amount.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_limit_cents BIGINT`,
  `CREATE TABLE IF NOT EXISTS claims (
    id              SERIAL PRIMARY KEY,
    claim_no        TEXT NOT NULL UNIQUE,
    employee_id     INTEGER NOT NULL REFERENCES users(id),
    claimant_name   TEXT NOT NULL,
    expense_date    TEXT NOT NULL,
    department      TEXT NOT NULL,
    bank_name       TEXT NOT NULL,
    recipient_name  TEXT NOT NULL,
    bank_account_no TEXT NOT NULL,
    expense_type    TEXT NOT NULL,
    amount_cents    BIGINT NOT NULL CHECK (amount_cents >= 0),
    currency        TEXT NOT NULL DEFAULT 'IDR',
    description     TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','approved','rejected','paid')),
    manager_id      INTEGER REFERENCES users(id),
    manager_comment TEXT NOT NULL DEFAULT '',
    decided_at      TIMESTAMPTZ,
    paid_by         INTEGER REFERENCES users(id),
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id            SERIAL PRIMARY KEY,
    claim_id      INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    blob_url      TEXT NOT NULL,
    blob_pathname TEXT NOT NULL DEFAULT '',
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS claim_history (
    id          SERIAL PRIMARY KEY,
    claim_id    INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    actor_id    INTEGER NOT NULL REFERENCES users(id),
    actor_name  TEXT NOT NULL,
    action      TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    comment     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // --- Settings / configuration lookups (managed by admins) ------------------
  `CREATE TABLE IF NOT EXISTS departments (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Regions scope data access: an account belongs to one region (or the special
  // "All regions") and, outside of super admins / all-region accounts, sees only
  // that region's claims. A managed lookup like departments. Seed the countries
  // the portal serves; a super admin can add / rename / disable them.
  `CREATE TABLE IF NOT EXISTS regions (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `INSERT INTO regions (name) VALUES ('Indonesia'),('Thailand'),('Vietnam'),('Philippines'),('Cambodia')
     ON CONFLICT (name) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS job_positions (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Front-page "purpose" buttons (New Claim / New Meal Allowance) are gated per
  // department AND per job position: a user sees a purpose only when it is
  // ticked on both their department and their position. New rows default to
  // FALSE (hidden) until an admin explicitly enables them.
  `ALTER TABLE departments   ADD COLUMN IF NOT EXISTS allow_claim BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE departments   ADD COLUMN IF NOT EXISTS allow_meal  BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE job_positions ADD COLUMN IF NOT EXISTS allow_claim BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE job_positions ADD COLUMN IF NOT EXISTS allow_meal  BOOLEAN NOT NULL DEFAULT FALSE`,
  // Job positions carry an explicit seniority `rank` (1 = most senior) and a
  // `can_manage` flag (may this position create/manage junior accounts?). These
  // replace the old hard-coded ladder: account management is scoped to positions
  // ranked strictly below the actor's own, and only can_manage positions (plus
  // admins/superadmins) may delegate at all.
  `ALTER TABLE job_positions ADD COLUMN IF NOT EXISTS rank       INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE job_positions ADD COLUMN IF NOT EXISTS can_manage BOOLEAN NOT NULL DEFAULT FALSE`,
  // One-time, idempotent backfills. Rank: seed from the legacy ladder for any
  // matching names, but only touch still-unranked rows (rank = 0) so re-running
  // migrate never clobbers an admin's reordering.
  `UPDATE job_positions AS jp SET rank = v.r FROM (VALUES
      ('super admin',1),('president director',2),('director',3),('senior general manager',4),
      ('general manager',5),('senior manager',6),('manager',7),('junior manager',8),
      ('assistant manager',9),('supervisor',10),('assistant supervisor',11),
      ('senior staff',12),('staff',13),('intern',14)
    ) AS v(name, r) WHERE lower(jp.name) = v.name AND jp.rank = 0`,
  // Any position whose name is off the legacy ladder falls in below it, ordered
  // by id so the assignment is stable and unique.
  `UPDATE job_positions SET rank = 100 + id WHERE rank = 0`,
  // Preserve today's delegation floor (Supervisor and up may manage accounts).
  // Guarded to the first run only: once any position has can_manage set, later
  // admin edits are left alone.
  `UPDATE job_positions SET can_manage = TRUE
     WHERE lower(name) IN ('super admin','president director','director','senior general manager',
       'general manager','senior manager','manager','junior manager','assistant manager','supervisor')
       AND NOT EXISTS (SELECT 1 FROM job_positions WHERE can_manage = TRUE)`,
  `CREATE TABLE IF NOT EXISTS expense_types (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // --- Per-region lookups ----------------------------------------------------
  // Departments, job positions and expense types are scoped to a region: each
  // region keeps its own list (own active flags, purpose gates and — for
  // positions — its own rank order). Add the region column, swap the global
  // name-uniqueness for per-region (region, name) uniqueness, then, on the first
  // run only, fan today's global entries out into every region: the originals
  // stay in the first region and copies are made for the rest. The still-blank
  // region marker ('') identifies un-migrated rows, so re-running never
  // duplicates or resurrects deletions.
  `ALTER TABLE departments   ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE job_positions ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE expense_types ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE departments   DROP CONSTRAINT IF EXISTS departments_name_key`,
  `ALTER TABLE job_positions DROP CONSTRAINT IF EXISTS job_positions_name_key`,
  `ALTER TABLE expense_types DROP CONSTRAINT IF EXISTS expense_types_name_key`,
  `ALTER TABLE departments   DROP CONSTRAINT IF EXISTS departments_region_name_key`,
  `ALTER TABLE job_positions DROP CONSTRAINT IF EXISTS job_positions_region_name_key`,
  `ALTER TABLE expense_types DROP CONSTRAINT IF EXISTS expense_types_region_name_key`,
  `ALTER TABLE departments   ADD CONSTRAINT departments_region_name_key   UNIQUE (region, name)`,
  `ALTER TABLE job_positions ADD CONSTRAINT job_positions_region_name_key UNIQUE (region, name)`,
  `ALTER TABLE expense_types ADD CONSTRAINT expense_types_region_name_key UNIQUE (region, name)`,
  // Fan-out copies into every region except the first (source = un-migrated
  // region-'' rows, so this fires only on the first run).
  `INSERT INTO departments (name, active, allow_claim, allow_meal, region)
     SELECT t.name, t.active, t.allow_claim, t.allow_meal, r.name
       FROM departments t CROSS JOIN regions r
      WHERE t.region = '' AND r.id <> (SELECT MIN(id) FROM regions)`,
  `INSERT INTO job_positions (name, active, allow_claim, allow_meal, rank, can_manage, region)
     SELECT t.name, t.active, t.allow_claim, t.allow_meal, t.rank, t.can_manage, r.name
       FROM job_positions t CROSS JOIN regions r
      WHERE t.region = '' AND r.id <> (SELECT MIN(id) FROM regions)`,
  `INSERT INTO expense_types (name, active, region)
     SELECT t.name, t.active, r.name
       FROM expense_types t CROSS JOIN regions r
      WHERE t.region = '' AND r.id <> (SELECT MIN(id) FROM regions)`,
  // Anchor the originals to the first region, clearing the '' marker.
  `UPDATE departments   SET region = (SELECT name FROM regions ORDER BY id LIMIT 1) WHERE region = '' AND EXISTS (SELECT 1 FROM regions)`,
  `UPDATE job_positions SET region = (SELECT name FROM regions ORDER BY id LIMIT 1) WHERE region = '' AND EXISTS (SELECT 1 FROM regions)`,
  `UPDATE expense_types SET region = (SELECT name FROM regions ORDER BY id LIMIT 1) WHERE region = '' AND EXISTS (SELECT 1 FROM regions)`,
  // An approval chain is a named, ordered sequence of approval steps ("lines").
  // It can optionally be scoped to a single department.
  `CREATE TABLE IF NOT EXISTS approval_chains (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL DEFAULT '',
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Each line is one step: an approver identified by job position, plus a label.
  `CREATE TABLE IF NOT EXISTS approval_lines (
    id             SERIAL PRIMARY KEY,
    chain_id       INTEGER NOT NULL REFERENCES approval_chains(id) ON DELETE CASCADE,
    step_order     INTEGER NOT NULL,
    position_id    INTEGER REFERENCES job_positions(id),
    approver_label TEXT NOT NULL DEFAULT ''
  )`,
  // Route claims through an approval chain: which chain, and the pending step.
  // (Added after approval_chains exists so the foreign key resolves.)
  // Each account has an ordered list of approvers (the users who approve that
  // account's claims, in sequence). Chosen from the created users in Settings.
  `ALTER TABLE users  ADD COLUMN IF NOT EXISTS approver_ids INTEGER[] NOT NULL DEFAULT '{}'`,
  // Optional candidate pool for a *chooseable* Approver 1. When non-empty, the
  // account holder must pick one of these accounts as the first approver each time
  // they submit a claim; the fixed `approver_ids` chain above then runs after that
  // chosen approver (as steps 2, 3, …). When empty, submission uses `approver_ids`
  // unchanged. Only a super admin edits this list.
  `ALTER TABLE users  ADD COLUMN IF NOT EXISTS approver1_options INTEGER[] NOT NULL DEFAULT '{}'`,
  // Per-account permission: may this account mark claims as paid (record the
  // payment)? Off by default; granted by a super admin in the account editor.
  // Super admins can always mark paid regardless of this flag.
  `ALTER TABLE users  ADD COLUMN IF NOT EXISTS can_mark_paid BOOLEAN NOT NULL DEFAULT FALSE`,
  // Creation audit: which account created this one (created through the app),
  // plus a snapshot of the creator's name at that time (survives later renames
  // and avoids a join). NULL / '' for accounts made directly via seed scripts or
  // before this column existed — shown as "—" (system / unknown).
  `ALTER TABLE users  ADD COLUMN IF NOT EXISTS created_by      INTEGER REFERENCES users(id)`,
  `ALTER TABLE users  ADD COLUMN IF NOT EXISTS created_by_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE claims ADD COLUMN IF NOT EXISTS db_no TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE claims ADD COLUMN IF NOT EXISTS approver_ids INTEGER[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE claims ADD COLUMN IF NOT EXISTS chain_id INTEGER REFERENCES approval_chains(id)`,
  `ALTER TABLE claims ADD COLUMN IF NOT EXISTS current_step INTEGER NOT NULL DEFAULT 0`,
  // Region is stamped onto each claim at creation (from the submitter's account),
  // like department — so a claim keeps its region even if the account changes.
  `ALTER TABLE claims ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT ''`,
  `UPDATE claims c SET region = u.region FROM users u
     WHERE c.employee_id = u.id AND c.region = '' AND u.region NOT IN ('', '*')`,
  // --- Meal allowance claims -------------------------------------------------
  // A meal allowance claim is a header plus many line items (one row per day on
  // the paper "Meal Allowance Claim Form"). It follows the same submit → approve
  // chain → reject/resubmit → paid workflow as reimbursement claims, using the
  // submitter account's ordered approver list.
  `CREATE TABLE IF NOT EXISTS meal_claims (
    id              SERIAL PRIMARY KEY,
    claim_no        TEXT NOT NULL UNIQUE,
    employee_id     INTEGER NOT NULL REFERENCES users(id),
    claimant_name   TEXT NOT NULL,
    department      TEXT NOT NULL DEFAULT '',
    bank_name       TEXT NOT NULL DEFAULT '',
    recipient_name  TEXT NOT NULL DEFAULT '',
    bank_account_no TEXT NOT NULL DEFAULT '',
    total_cents     BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
    currency        TEXT NOT NULL DEFAULT 'IDR',
    status          TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','approved','rejected','paid')),
    manager_id      INTEGER REFERENCES users(id),
    manager_comment TEXT NOT NULL DEFAULT '',
    decided_at      TIMESTAMPTZ,
    paid_by         INTEGER REFERENCES users(id),
    paid_at         TIMESTAMPTZ,
    approver_ids    INTEGER[] NOT NULL DEFAULT '{}',
    current_step    INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS meal_claim_lines (
    id            SERIAL PRIMARY KEY,
    meal_claim_id INTEGER NOT NULL REFERENCES meal_claims(id) ON DELETE CASCADE,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    line_date     TEXT NOT NULL DEFAULT '',
    site          TEXT NOT NULL DEFAULT '',
    job_category  TEXT NOT NULL DEFAULT '',
    amount_cents  BIGINT NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
    description   TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS meal_claim_history (
    id            SERIAL PRIMARY KEY,
    meal_claim_id INTEGER NOT NULL REFERENCES meal_claims(id) ON DELETE CASCADE,
    actor_id      INTEGER NOT NULL REFERENCES users(id),
    actor_name    TEXT NOT NULL,
    action        TEXT NOT NULL,
    from_status   TEXT,
    to_status     TEXT,
    comment       TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE meal_claims ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT ''`,
  `UPDATE meal_claims c SET region = u.region FROM users u
     WHERE c.employee_id = u.id AND c.region = '' AND u.region NOT IN ('', '*')`,
  `CREATE INDEX IF NOT EXISTS idx_meal_lines_claim   ON meal_claim_lines(meal_claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_meal_history_claim ON meal_claim_history(meal_claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_meal_claims_employee ON meal_claims(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_meal_claims_status   ON meal_claims(status)`,
  `CREATE INDEX IF NOT EXISTS idx_claims_employee ON claims(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_claims_status   ON claims(status)`,
  `CREATE INDEX IF NOT EXISTS idx_attach_claim    ON attachments(claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_history_claim   ON claim_history(claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_appr_lines_chain ON approval_lines(chain_id)`,
  // --- Password reset tokens --------------------------------------------------
  // A one-time, time-limited token for the "forgot password" flow. Only the
  // SHA-256 hash of the token is stored; the raw token lives only in the emailed
  // link. A row is consumed (used_at set) on a successful reset.
  `CREATE TABLE IF NOT EXISTS password_resets (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pwreset_token ON password_resets(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_pwreset_user  ON password_resets(user_id)`,
  // --- App-wide settings (key/value) ------------------------------------------
  // Simple key/value store for global configuration a super admin controls from
  // the Settings screen. Current keys:
  //   claim_max_age_days  — rolling window: an expense dated more than N days
  //                         before today (Asia/Jakarta) can't be claimed. '' / 0 = off.
  //   claim_earliest_date — absolute cutoff (YYYY-MM-DD): no expense dated before
  //                         this can be claimed. '' = off.
  // Both may be set; the effective earliest claimable date is the later of the two.
  `CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // --- Login throttling -------------------------------------------------------
  // Failed-login counter, keyed by client IP. Kept in the database (not just an
  // in-memory Map) so the limit holds across serverless instances, which each
  // used to keep their own private counter. `first_at` marks the start of the
  // current window; a row is cleared on a successful login or once its window
  // has elapsed.
  `CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_key TEXT PRIMARY KEY,
    fails       INTEGER NOT NULL DEFAULT 0,
    first_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`
];

module.exports = { SCHEMA };
