'use strict';
const app = require('./app');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`\n  Reimbursement portal (local) on http://localhost:${PORT}`);
  console.log('  Needs DATABASE_URL (Neon) and BLOB_READ_WRITE_TOKEN in the environment.\n');
});
