# Reimbursement Portal — Vercel build

A reimbursement claim portal with manager approval and finance export, built to
run on **Vercel** with **Neon Postgres** (database) and **Vercel Blob** (receipt
files). Login is the entry point; only an admin can create members.

## Why these pieces

Vercel runs serverless functions with a read-only, ephemeral filesystem, so a
local SQLite file and on-disk uploads can't persist. This build moves storage to
managed services:

- **Database → Neon Postgres** (serverless, accessed over HTTP)
- **Receipt files → Vercel Blob** (object storage)
- **Sessions → signed cookie** (no server-side session store needed)

## What it does

- **Employees** submit claims (Name, Date, Department, Bank Name, Recipient Name,
  Bank Account No., Type of Expense, Amount, Description) and attach receipts.
- **Managers** approve, or reject with a reason — rejected claims go back to the
  claimant to edit and resubmit.
- **Finance** marks approved claims paid and exports everything to CSV.
- **Admin** creates and manages user accounts. There is no self-signup.

Every claim keeps a full history/audit trail.

## Environment variables

| Variable               | What it is                                              |
|------------------------|--------------------------------------------------------|
| `DATABASE_URL`         | Neon Postgres connection string (set by the Neon integration) |
| `BLOB_READ_WRITE_TOKEN`| Vercel Blob token (set by the Blob integration)        |
| `SESSION_SECRET`       | Long random string used to sign the login cookie       |
| `SEED_ADMIN_PASSWORD`  | First admin password, used only by the one-time DB setup |

## Deploy to Vercel

### 1. Put the code in a Git repo

```bash
git init && git add . && git commit -m "Reimbursement portal (Vercel)"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

### 2. Import the repo into Vercel

In the Vercel dashboard: **Add New → Project**, pick the repo, and deploy. (The
included `vercel.json` routes all requests to the Express app.)

### 3. Add the database — Neon

Project → **Storage → Create → Neon Postgres** (Vercel Marketplace). Connecting it
to the project automatically sets `DATABASE_URL` for you.

### 4. Add file storage — Vercel Blob

Project → **Storage → Create → Blob**. This sets `BLOB_READ_WRITE_TOKEN`
automatically. A **public** store is fine: receipt URLs get an unguessable random
suffix and are never sent to the browser — downloads are proxied through an
authenticated route, so access is still gated by login.

### 5. Set the remaining env vars

Project → **Settings → Environment Variables**, add:
- `SESSION_SECRET` — a long random string (e.g. `openssl rand -hex 32`)
- `SEED_ADMIN_PASSWORD` — your chosen first-admin password

### 6. Create the tables and the admin (run once)

From your machine, using the Neon connection string:

```bash
npm install
DATABASE_URL="postgres://...your neon url..." \
SEED_ADMIN_PASSWORD="your-admin-password" \
npm run setup-db
```

This creates the tables and the single `admin` account.

### 7. Redeploy and sign in

Trigger a redeploy (so the new env vars apply), open your
`https://<project>.vercel.app` URL, sign in as **`admin`**, change the password,
and create your members in **Users**.

## Local development

```bash
npm install
# pull the env vars Vercel set (Neon URL + Blob token), or set them yourself:
#   export DATABASE_URL=... BLOB_READ_WRITE_TOKEN=... SESSION_SECRET=dev
npm start          # http://localhost:3000
```

The local server talks to the same Neon database and Blob store over the network.

## Notes & limits

- **Upload size:** files go through the function, which on Vercel caps request
  bodies at ~4.5 MB, so each receipt is limited to **4 MB**. (Larger files would
  need Vercel Blob "client uploads," which can be added later.)
- **Login throttling** is in-memory, so it resets when a serverless instance
  recycles — still useful, but not a substitute for a shared rate limiter at
  higher scale.
- **Backups:** Neon keeps automatic history/branching; Blob has its own
  durability. Export to CSV any time from the Finance view.

## Tech

Express (exported as a Vercel function), `@neondatabase/serverless`,
`@vercel/blob`, `cookie-session`, Multer (memory storage), bcryptjs, and a
dependency-free vanilla-JS frontend.
