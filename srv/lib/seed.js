// (Re)loads the §5 seed from db/data/*.csv and resolves date offsets relative to today.
const cds = require('@sap/cds')
const fs = require('fs'), path = require('path')
const { offsetToDate, offsetToTimestamp } = require('./dates')

const DATA_DIR = path.join(__dirname, '..', '..', 'db', 'data')

function parseCSV (text) {
  const rows = []; let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ';') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function convert (element, v) {
  if (v === '' || v == null) return null
  switch (element?.type) {
    case 'cds.Integer': case 'cds.Int32': case 'cds.Int64': case 'cds.Integer64': return parseInt(v, 10)
    case 'cds.Double': case 'cds.Decimal': return Number(v)
    case 'cds.Boolean': return v === 'true' || v === '1'
    default: return v
  }
}

/** Fill Date/Timestamp columns of the seed rows (CSV keeps offsets only). */
async function applyDateOffsets (tx) {
  const { MaterialPrices, PriceApprovalRequests, Outcomes } = cds.entities('optisell')
  await tx.run(UPDATE(MaterialPrices).set({ price_valid_from: offsetToDate(-30) }))
  await tx.run(UPDATE(MaterialPrices).set({ price_valid_from: offsetToDate(-2), approval_decided_at: offsetToTimestamp(-2) })
    .where({ batch: 'B2309' }))
  await tx.run(UPDATE(PriceApprovalRequests).set({ created: offsetToDate(-2), requested_at: offsetToTimestamp(-2),
    decided_at: offsetToTimestamp(-2) }).where({ proposal_id: { in: ['P-0001', 'P-0002'] } }))
  await tx.run(UPDATE(PriceApprovalRequests).set({ applied_at: offsetToTimestamp(-2) }).where({ proposal_id: 'P-0001' }))
  await tx.run(UPDATE(Outcomes).set({ recorded: offsetToDate(-1) }).where({ proposal_id: 'P-0001' }))
}

/** Wipe all optisell entities and reload them from the CSV seed. */
async function resetDemoData () {
  const entities = cds.entities('optisell')
  await cds.db.tx(async tx => {
    for (const [name, entity] of Object.entries(entities)) {
      await tx.run(DELETE.from(entity))
      const file = path.join(DATA_DIR, `optisell-${name}.csv`)
      if (!fs.existsSync(file)) continue
      const [header, ...rows] = parseCSV(fs.readFileSync(file, 'utf8'))
      const entries = rows.map(r => Object.fromEntries(header.map((h, i) => [h, convert(entity.elements[h], r[i])])))
      if (entries.length) await tx.run(INSERT.into(entity).entries(entries))
    }
    await applyDateOffsets(tx)
  })
}

module.exports = { resetDemoData, applyDateOffsets }
