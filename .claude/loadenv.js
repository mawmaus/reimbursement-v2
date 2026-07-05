'use strict';
// Dev-only preloader: loads .env.local into process.env before the server
// starts (Vercel injects these in production, so server.js has no dotenv).
const fs = require('fs');
const path = require('path');
try {
  const file = path.join(process.cwd(), '.env.local');
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
} catch (e) {
  console.warn('loadenv: could not read .env.local —', e.message);
}
