'use strict';

// Error responses. Route handlers answer expected problems themselves
// (res.status(4xx).json(...)); anything thrown reaches errorHandler, which
// separates the two kinds of thrown error:
//  - deliberate: an `expose`d 4xx — httpError() below, or Express/body-parser's
//    own (malformed JSON → 400, upload over the limit → 413). Its message is
//    meant for the user and its status is kept;
//  - everything else — a bug, a database or storage outage. The user gets a
//    plain 500 (never the raw message, which can carry SQL or internals) and
//    the full error is logged with the request it came from.

const GENERIC_MESSAGE = 'Something went wrong on our side. Please try again, and contact support if it keeps happening.';

// An error whose message is safe to show, with the HTTP status to send.
function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function errorHandler(err, req, res, next) {
  const status = Number(err && (err.status || err.statusCode));
  if (err && err.expose && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message || 'Request failed' });
  }
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  // A response already under way (e.g. a streamed download) can't be replaced;
  // Express's default handler closes the connection instead.
  if (res.headersSent) return next(err);
  res.status(500).json({ error: GENERIC_MESSAGE });
}

module.exports = { httpError, errorHandler, GENERIC_MESSAGE };
