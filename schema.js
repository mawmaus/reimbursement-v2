'use strict';

// Postgres schema for the reimbursement portal. Each statement is run
// individually (Neon's HTTP driver executes one statement per call).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('superadmin','user')),
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
  // Collapse the old four-role model (employee/manager/finance/admin) down to
  // two: superadmin and user. Drop the old CHECK, remap the data, re-add it.
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
  `UPDATE users SET role = 'superadmin' WHERE role = 'admin'`,
  `UPDATE users SET role = 'user' WHERE role <> 'superadmin'`,
  `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin','user'))`,
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
  `CREATE TABLE IF NOT EXISTS expense_types (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
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
  `ALTER TABLE claims ADD COLUMN IF NOT EXISTS approver_ids INTEGER[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE claims ADD COLUMN IF NOT EXISTS chain_id INTEGER REFERENCES approval_chains(id)`,
  `ALTER TABLE claims ADD COLUMN IF NOT EXISTS current_step INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_claims_employee ON claims(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_claims_status   ON claims(status)`,
  `CREATE INDEX IF NOT EXISTS idx_attach_claim    ON attachments(claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_history_claim   ON claim_history(claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_appr_lines_chain ON approval_lines(chain_id)`
];

module.exports = { SCHEMA };
