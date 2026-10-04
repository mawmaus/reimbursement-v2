'use strict';

// Session user loading and the requireAuth / requireRole / requireCap
// middleware.

const { q } = require('../db');
const { ah } = require('./util');
const { loadAppSettings, seesAllRegions } = require('./settings');
const { attachCaps, userCan } = require('./permissions');

// Sessions live only in the signed cookie, so the server can't revoke one
// directly. Instead each account carries a session_version, bumped by every
// password change (SET_PASSWORD_SQL); a cookie issued under an older version is
// refused. Cookies from before this existed carry none and count as version 0.
const SET_PASSWORD_SQL =
  'UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING session_version';
const sessionCurrent = (session, user) =>
  Number((session && session.sv) || 0) === Number(user.session_version || 0);
// Sign `user` in on this request's cookie (or keep it signed in after it
// changed its own password, with the version just returned).
function startSession(req, user) {
  req.session.userId = user.id;
  req.session.sv = Number(user.session_version) || 0;
}

async function loadUser(req) {
  const id = req.session && req.session.userId;
  if (!id) return null;
  const rows = await q('SELECT id, username, full_name, email, role, department, position, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options, can_mark_paid, allow_advance, approval_limit_cents, language, region, active, session_version FROM users WHERE id = $1', [id]);
  const u = rows[0];
  if (!u || !sessionCurrent(req.session, u)) return null;
  delete u.session_version; // internal: never part of the user payload
  return u;
}
const requireAuth = ah(async (req, res, next) => {
  // The settings don't depend on who the user is, so both reads go out at once.
  const [u, settings] = await Promise.all([loadUser(req), loadAppSettings()]);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  await attachCaps(u, settings);
  req.user = u;
  next();
});
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    next();
  };
}
// Like requireRole, but gates on an editable capability from the role matrix.
// Must run after requireAuth (which attaches req.user.caps).
function requireCap(cap) {
  return (req, res, next) => {
    if (!userCan(req.user, cap)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    next();
  };
}

// Region isolation for actions. Every read of a document (claim, meal claim,
// cash advance, receipt) already refuses one from outside the user's region;
// this applies the same rule to everything that changes one, so a region-scoped
// payer or admin can't act on another region's documents by their id. Super
// admins, VPs and All-regions accounts pass, as they do for reads.
const inUserRegion = (user, row) =>
  seesAllRegions(user) || String(row.region || '') === String(user.region || '');
// Answers 403 and returns true when the document is out of the user's region.
function refuseOutOfRegion(req, res, row) {
  if (inUserRegion(req.user, row)) return false;
  res.status(403).json({ error: 'This document belongs to another region' });
  return true;
}

module.exports = {
  loadUser, requireAuth, requireCap, requireRole, inUserRegion, refuseOutOfRegion,
  SET_PASSWORD_SQL, sessionCurrent, startSession
};
