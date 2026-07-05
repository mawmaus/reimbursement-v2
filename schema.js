'use strict';

// Postgres schema for the reimbursement portal. Each statement is run
// individually (Neon's HTTP driver executes one statement per call).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('employee','manager','finance','admin')),
    department    TEXT NOT NULL DEFAULT '',
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
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
  `CREATE INDEX IF NOT EXISTS idx_claims_employee ON claims(employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_claims_status   ON claims(status)`,
  `CREATE INDEX IF NOT EXISTS idx_attach_claim    ON attachments(claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_history_claim   ON claim_history(claim_id)`
];

module.exports = { SCHEMA };
