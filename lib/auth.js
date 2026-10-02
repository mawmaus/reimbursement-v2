'use strict';

// Session user loading and the requireAuth / requireRole / requireCap
// middleware.

const { q } = require('../db');
const { ah } = require('./util');
const { loadAppSettings } = require('./settings');
const { attachCaps, userCan } = require('./permissions');

async function loadUser(req) {
  const id = req.session && req.session.userId;
  if (!id) return null;
  const rows = await q('SELECT id, username, full_name, email, role, department, position, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options, can_mark_paid, allow_advance, approval_limit_cents, language, region, active FROM users WHERE id = $1', [id]);
  return rows[0] || null;
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

module.exports = {
  loadUser, requireAuth, requireCap, requireRole
};
