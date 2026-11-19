// All dates are UTC and computed per request — seed data stores offsets only.
const DAY = 86400000

/** "YYYY-MM-DD" for today (UTC) */
const today = () => new Date().toISOString().slice(0, 10)

/** "YYYY-MM-DD" for today + n days (UTC) */
const offsetToDate = (n, base = today()) => new Date(Date.parse(base + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10)

/** "YYYY-MM-DDTHH:MM:SSZ" (UTC, no milliseconds) */
const toTimestamp = d => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** current timestamp "YYYY-MM-DDTHH:MM:SSZ" */
const now = () => toTimestamp(Date.now())

/** normalise a stored Timestamp (or null) to the contract format */
const fmtTimestamp = v => v == null ? null : toTimestamp(v)

/** timestamp n days from now (used by the seed loader) */
const offsetToTimestamp = n => toTimestamp(Date.now() + n * DAY)

module.exports = { today, offsetToDate, now, fmtTimestamp, toTimestamp, offsetToTimestamp }
