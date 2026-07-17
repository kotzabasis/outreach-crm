// Marks a GET response as revalidatable: the browser may cache it but must
// check back before reusing it. Express already computes a (weak) ETag for
// JSON responses and returns 304 Not Modified when the client's If-None-Match
// matches — a 304 has no body, so for endpoints the frontend polls (dashboard
// counts, analytics, contacts) this turns most "nothing changed" polls into
// tiny 304s instead of resending the full payload. That matters on Render's
// free tier, whose egress budget is small (see the compression note in
// server.js). "private" keeps these per-user responses out of any shared cache.
function revalidatable(req, res, next) {
  res.set("Cache-Control", "private, no-cache");
  next();
}

module.exports = { revalidatable };
