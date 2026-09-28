// Working-day calendar for TAT. A TAT day is any day that is not a Sunday and
// not listed in the admin-managed holiday list (admin_config key 'holidays',
// an array of { date: 'YYYY-MM-DD', name }). Mirrors the tat* helpers in
// index.html exactly, so the deadline the frontend shows and the delay the
// backend stamps are counted the same way.
//
// All dates are plain 'YYYY-MM-DD' strings handled in UTC, so the server's
// timezone can never shift a day.

async function loadHolidaySet(client) {
  const { rows } = await client.query(
    "SELECT config_value FROM admin_config WHERE config_key = 'holidays'"
  );
  const list = rows[0] && Array.isArray(rows[0].config_value) ? rows[0].config_value : [];
  return new Set(list.map((h) => String((h && h.date) || h).slice(0, 10)).filter(Boolean));
}

function toDate(s) { return new Date(String(s).slice(0, 10) + 'T00:00:00Z'); }
function toStr(d) { return d.toISOString().slice(0, 10); }

function isWorkingDay(dateStr, holidays) {
  const d = toDate(dateStr);
  return d.getUTCDay() !== 0 && !holidays.has(toStr(d));
}

// dateStr + n working days (counting from the day after dateStr).
function addWorkingDays(dateStr, n, holidays) {
  const d = toDate(dateStr);
  let left = Math.max(0, Math.round(n || 0));
  let safety = 0;
  while (left > 0 && safety++ < 3660) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(toStr(d), holidays)) left--;
  }
  return toStr(d);
}

// Signed working-day count from `from` to `to`: working days in (from, to]
// when to is later, negative working days in (to, from] when to is earlier.
function workingDaysBetween(from, to, holidays) {
  if (!from || !to) return null;
  const a = toStr(toDate(from)), b = toStr(toDate(to));
  if (a === b) return 0;
  const sign = b > a ? 1 : -1;
  const d = toDate(sign > 0 ? a : b), end = sign > 0 ? b : a;
  let count = 0, safety = 0;
  while (toStr(d) < end && safety++ < 3660) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(toStr(d), holidays)) count++;
  }
  return sign * count;
}

// Working days a Hold consumed: held from holdDate up to (not including) resumeDate.
function heldWorkingDays(holdDate, resumeDate, holidays) {
  if (!holdDate || !resumeDate || resumeDate <= holdDate) return 0;
  const d = toDate(holdDate), end = toStr(toDate(resumeDate));
  let count = 0, safety = 0;
  while (toStr(d) < end && safety++ < 3660) {
    if (isWorkingDay(toStr(d), holidays)) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

module.exports = { loadHolidaySet, isWorkingDay, addWorkingDays, workingDaysBetween, heldWorkingDays, todayStr };
