'use strict';

// Region-wide insights: a Country Manager / Managing Director granted "View
// region-wide insights" (and not company-wide) sees Insights for their own
// region only — the top-bar region picker can't move them. Through the real
// app (see _app.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, serve, call } = require('./_app');

const CM = 50, VP_LIKE = 51;
state.regions = ['Indonesia', 'Thailand', 'Cambodia'];
state.users.set(CM, account({ id: CM, role: 'admin', region: 'Cambodia', department: 'Management' }));
state.users.set(VP_LIKE, account({ id: VP_LIKE, role: 'admin', region: 'Indonesia', department: 'Management' }));
state.settings.role_permissions = {};
state.settings.role_permissions_by_region = {
  Cambodia: { admin: { view_insights_region: true } },
  Indonesia: { admin: { view_insights_all: true } }
};

test('a region-wide CM/MD is pinned to their own region, whatever region they pick', async (t) => {
  await serve(t);
  const r = await call(CM, 'GET', '/api/insights?region=Thailand');
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.scope.mode, 'all', 'every department in the region');
  assert.equal(r.json.scope.region, 'Cambodia');
});

test('a company-wide CM/MD keeps the region picker', async (t) => {
  await serve(t);
  const all = await call(VP_LIKE, 'GET', '/api/insights');
  assert.equal(all.status, 200, all.body);
  assert.equal(all.json.scope.region, null);
});
