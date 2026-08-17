// Built-in defaults for the (now editable) unsubscribe copy. Stored empty on
// the Company by default; company.js fills these in on read and tracking.js
// falls back to them, so a workspace that never customizes anything keeps the
// original wording. The footer MUST keep the {{unsubscribe_link}} token — it's
// what resolves to the real per-send unsubscribe URL at send time.
const DEFAULT_UNSUBSCRIBE_TEXT =
  '<p><br></p><div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;font-family:sans-serif;font-size:11px;color:#94a3b8;">Αν δεν θέλετε να λάβετε καμία άλλη επικοινωνία από εμάς, <a href="{{unsubscribe_link}}" style="color:#94a3b8;text-decoration:underline;">πατήστε εδώ</a>.</div>';

const DEFAULT_CONFIRM_TITLE = "Έγινε η απεγγραφή σου.";
const DEFAULT_CONFIRM_MESSAGE = "Δεν θα λαμβάνεις άλλα emails.";

module.exports = { DEFAULT_UNSUBSCRIBE_TEXT, DEFAULT_CONFIRM_TITLE, DEFAULT_CONFIRM_MESSAGE };
