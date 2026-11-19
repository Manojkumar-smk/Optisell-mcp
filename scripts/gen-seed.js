#!/usr/bin/env node
// Generates db/data/*.csv from the §5 seed table. Offsets only — never absolute dates.
// Date/Timestamp columns are left empty here and resolved relative to "today"
// by srv/lib/seed.js (applyDateOffsets) at startup and on reset_demo_data.
const fs = require('fs'), path = require('path')
const dir = path.join(__dirname, '..', 'db', 'data')
const STORE = 'S101'

const stock = [
  // sku, name, category, batch, qty, expiry_offset, daily_rate, price, unit_cost
  ['MLK-1L',  'Toned milk 1L',          'dairy',   'B2301', 120, 3, 15,  68,  40],
  ['YGT-GRK', 'Greek yogurt 100g',      'dairy',   'B2302',  60, 2, 12,  60,  50],
  ['CRS-2PC', 'Croissant 2 pc',         'bakery',  'B2303',  30, 1,  6,  90,  45],
  ['CRD-400', 'Curd 400g',              'dairy',   'B2304',  30, 0, 25,  45,  34],
  ['CRD-400', 'Curd 400g',              'dairy',   'B2305',  80, 4, 25,  45,  34],
  ['BAN-12',  'Bananas 12 pc',          'produce', 'B2306',  50, 3, 18,  60,  40],
  ['STR-200', 'Strawberries 200g',      'produce', 'B2307',  30, 2,  4, 150, 100],
  ['BRD-WW',  'Whole wheat bread 400g', 'bakery',  'B2308',  40, 2, 20,  50,  35],
  ['SPN-BN',  'Spinach bunch',          'produce', 'B2309',  40, 1, 15,  30,  18],
  ['PNR-200', 'Paneer 200g',            'dairy',   'B2310',  45, 3, 10,  95,  70],
  ['TOM-1KG', 'Tomato 1 kg',            'produce', 'B2311',  80, 5, 30,  40,  30],
]

const q = v => v === null || v === undefined ? '' : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)
function write (entity, cols, rows) {
  const lines = [cols.join(';'), ...rows.map(r => cols.map(c => q(r[c])).join(';'))]
  fs.writeFileSync(path.join(dir, `optisell-${entity}.csv`), lines.join('\n') + '\n')
}

write('StockBatches', ['batch', 'store_id', 'sku', 'name', 'category', 'qty', 'expiry_offset', 'unit_cost'],
  stock.map(([sku, name, category, batch, qty, expiry_offset, , , unit_cost]) =>
    ({ batch, store_id: STORE, sku, name, category, qty, expiry_offset, unit_cost })))

write('MaterialPrices', ['store_id', 'sku', 'batch', 'regular_price', 'current_price', 'currency', 'approval_status',
  'active_proposal_id', 'sbpa_instance_id', 'proposed_price', 'last_decided_by'],
  stock.map(([sku, , , batch, , , , price]) => {
    const r = { store_id: STORE, sku, batch, regular_price: price, current_price: price, currency: 'INR', approval_status: 'NONE' }
    if (batch === 'B2309') Object.assign(r, { current_price: 24, approval_status: 'APPLIED', last_decided_by: 'store.manager@optisell.example' })
    return r
  }))

// Forecast + sales: one row per SKU (CRD-400 appears twice in stock, same rate)
const rates = new Map(stock.map(s => [s[0], s[6]]))
write('Forecast', ['sku', 'store_id', 'daily_units'], [...rates].map(([sku, daily_units]) => ({ sku, store_id: STORE, daily_units })))

const m = [1.0, 1.1, 0.9, 1.0, 1.05, 0.95, 1.0, 1.1, 0.9, 1.0, 1.0, 1.05, 0.95, 1.0]
const sales = []
for (const [sku, rate] of rates) {
  const units = m.map(f => Math.round(rate * f))
  units[13] += rate * 14 - units.reduce((a, b) => a + b, 0) // adjust the −1 row → exact total
  units.forEach((u, i) => sales.push({ sku, day_offset: i - 14, store_id: STORE, units: u }))
}
write('SalesDaily', ['sku', 'day_offset', 'store_id', 'units'], sales)

write('Events', ['name', 'store_id', 'day_offset', 'impact_pct', 'categories'],
  [{ name: 'Heavy rain', store_id: STORE, day_offset: 1, impact_pct: -20, categories: 'dairy,bakery,produce' }])

write('MarkdownPolicies', ['category', 'floor_margin_pct', 'min_markdown_pct', 'max_markdown_pct', 'step_pct', 'elasticity'], [
  { category: 'dairy',   floor_margin_pct: 15, min_markdown_pct: 10, max_markdown_pct: 50, step_pct: 10, elasticity: -2.2 },
  { category: 'bakery',  floor_margin_pct: 15, min_markdown_pct: 10, max_markdown_pct: 50, step_pct: 10, elasticity: -2.8 },
  { category: 'produce', floor_margin_pct: 15, min_markdown_pct: 10, max_markdown_pct: 50, step_pct: 10, elasticity: -2.0 },
])

write('CompetitorPrices', ['sku', 'name', 'price', 'observed_offset'], [
  { sku: 'BAN-12',  name: 'FreshMart',   price: 48.0,  observed_offset: 0 },
  { sku: 'STR-200', name: 'QuickCart',   price: 129.0, observed_offset: 0 },
  { sku: 'MLK-1L',  name: 'DailyBasket', price: 66.0,  observed_offset: 0 },
  { sku: 'CRS-2PC', name: 'FreshMart',   price: 80.0,  observed_offset: 0 },
])

write('Counters', ['name', 'value'], [{ name: 'proposal', value: 3 }])

write('PriceApprovalRequests', ['proposal_id', 'store_id', 'sku', 'batch', 'old_price', 'new_price', 'discount_pct', 'margin_pct',
  'at_risk_qty', 'margin_breach', 'reason', 'approver_role', 'status', 'sbpa_instance_id', 'sbpa_definition_id', 'requested_by',
  'decided_by', 'decision_comment'], [
  { proposal_id: 'P-0001', store_id: STORE, sku: 'SPN-BN', batch: 'B2309', old_price: 30, new_price: 24, discount_pct: 20,
    margin_pct: 25.0, at_risk_qty: 13, margin_breach: false, reason: 'Expires in 1 day, 13 units at risk',
    approver_role: 'store_manager', status: 'applied', sbpa_instance_id: 'seed-0001', sbpa_definition_id: 'seed',
    requested_by: 'optisell-agent', decided_by: 'store.manager@optisell.example', decision_comment: 'Approved' },
  { proposal_id: 'P-0002', store_id: STORE, sku: 'BRD-WW', batch: 'B2308', old_price: 50, new_price: 40, discount_pct: 20,
    margin_pct: 12.5, at_risk_qty: 0, margin_breach: true, reason: 'Promotional markdown',
    approver_role: 'category_manager', status: 'rejected', sbpa_instance_id: 'seed-0002', sbpa_definition_id: 'seed',
    requested_by: 'optisell-agent', decided_by: 'category.manager@optisell.example', decision_comment: 'Margin below floor' },
])

write('Outcomes', ['proposal_id', 'units_sold', 'units_wasted', 'recovered_value'],
  [{ proposal_id: 'P-0001', units_sold: 13, units_wasted: 0, recovered_value: 312.0 }])

console.log('seed CSVs written to', dir)
