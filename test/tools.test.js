// §7 acceptance tests — always run with SBPA_MODE=mock (forced below, no network calls).
process.env.SBPA_MODE = 'mock'
const cds = require('@sap/cds')
const { axios } = cds.test(__dirname + '/..')

const AGENT = { username: 'agent', password: '' }   // scope Tools
const SBPA = { username: 'sbpa', password: '' }     // scope SbpaCallback
const NOBODY = { username: 'nobody', password: '' } // no scopes

const bodies = [] // every response body, checked in test 16
async function call (path, data = {}, auth = AGENT) {
  const res = await axios.post(path, data, { auth, validateStatus: () => true })
  bodies.push({ path, status: res.status, data: res.data })
  return res
}
const tool = (name, data, auth) => call(`/tools/${name}`, data, auth)
const callback = (data, auth = SBPA) => call('/sbpa/complete_approval', data, auth)

const db = () => cds.entities('optisell')
const priceRow = batch => SELECT.one.from(db().MaterialPrices).where({ batch })
const request = proposal_id => SELECT.one.from(db().PriceApprovalRequests).where({ proposal_id })
const counter = async () => (await SELECT.one.from(db().Counters).where({ name: 'proposal' })).value

const proposalFor = (sku, batch, new_price, extra = {}) => ({
  store_id: 'S101', sku, batch, old_price: 999, new_price, discount_pct: 30, margin_pct: 16.0,
  margin_breach: false, at_risk_qty: 63, reason: 'Expires in 3 days, 63 units at risk', ...extra
})

const PROPOSAL_FIELDS = ['proposal_id', 'store_id', 'sku', 'batch', 'old_price', 'new_price', 'discount_pct', 'margin_pct',
  'margin_breach', 'at_risk_qty', 'reason', 'status', 'approver_role', 'created']
function expectProposal (p) {
  for (const f of PROPOSAL_FIELDS) expect(p).toHaveProperty(f)
  expect(typeof p.old_price).toBe('number')
  expect(typeof p.new_price).toBe('number')
  expect(typeof p.margin_breach).toBe('boolean')
  expect(p.created).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  for (const t of ['decided_at', 'requested_at', 'applied_at'])
    if (p[t] != null) expect(p[t]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
}

// §3.2 invariants, checked after every test
async function checkInvariants () {
  for (const r of await SELECT.from(db().MaterialPrices)) {
    if (['TRIGGERING', 'PENDING'].includes(r.approval_status)) {
      expect(r.active_proposal_id).not.toBeNull()
      expect(r.proposed_price).not.toBeNull()
      if (r.approval_status === 'PENDING') expect(r.sbpa_instance_id).not.toBeNull()
    } else {
      expect([r.batch, r.active_proposal_id, r.sbpa_instance_id, r.proposed_price]).toEqual([r.batch, null, null, null])
    }
  }
}

describe('OptiSell tools — §7 acceptance', () => {
  let p3 // P-0003

  beforeAll(async () => { await call('/admin/reset_demo_data', {}) })
  afterEach(checkInvariants)

  test('1. get_store_stock returns 11 items; MLK-1L price 68, NONE', async () => {
    const { status, data } = await tool('get_store_stock', { store_id: 'S101' })
    expect(status).toBe(200)
    expect(data.store_id).toBe('S101')
    expect(data.currency).toBe('INR')
    expect(data.items).toHaveLength(11)
    const mlk = data.items.find(i => i.sku === 'MLK-1L')
    expect(mlk).toMatchObject({ batch: 'B2301', name: 'Toned milk 1L', category: 'dairy', qty: 120, unit_cost: 40,
      price: 68, approval_status: 'NONE', active_proposal_id: null })
    expect(mlk.expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(data.items.find(i => i.batch === 'B2309')).toMatchObject({ price: 24, approval_status: 'APPLIED' })
  })

  test('2. get_sales_history MLK-1L sums to 210; from_date / to_date', async () => {
    const { status, data } = await tool('get_sales_history', { store_id: 'S101', sku: 'MLK-1L' })
    expect(status).toBe(200)
    expect(data).toHaveProperty('from_date')
    expect(data).toHaveProperty('to_date')
    expect(data.sales).toHaveLength(14)
    expect(data.sales.reduce((s, r) => s + r.units, 0)).toBe(210)
    const t = new Date().toISOString().slice(0, 10)
    expect(data.to_date).toBe(t)
    expect(data.from_date).toBe(new Date(Date.parse(t) - 13 * 86400000).toISOString().slice(0, 10))
  })

  test('read tools: demand signals, policy, competitor prices, 404s', async () => {
    const ds = await tool('get_demand_signals', { store_id: 'S101' })
    expect(ds.data.forecast.find(f => f.sku === 'MLK-1L').daily_units).toBe(15)
    expect(ds.data.events[0]).toMatchObject({ name: 'Heavy rain', impact_pct: -20, categories: ['dairy', 'bakery', 'produce'] })
    const pol = await tool('get_markdown_policy', { category: 'dairy' })
    expect(pol.data).toEqual({ category: 'dairy', floor_margin_pct: 15, min_markdown_pct: 10, max_markdown_pct: 50, step_pct: 10, elasticity: -2.2 })
    const unknown = await tool('get_markdown_policy', { category: 'frozen' })
    expect(unknown.status).toBe(404)
    expect(unknown.data.error).toMatchObject({ code: expect.any(String), message: expect.any(String) })
    const cp = await tool('get_competitor_prices', { store_id: 'S101', sku: 'BAN-12' })
    expect(cp.data.competitor_prices).toEqual([{ name: 'FreshMart', price: 48, observed: new Date().toISOString().slice(0, 10) }])
    const none = await tool('get_competitor_prices', { store_id: 'S101', sku: 'TOM-1KG' })
    expect(none.data).toEqual({ sku: 'TOM-1KG', competitor_prices: [] })
    const kpi = await tool('get_markdown_kpis', { store_id: 'S101' })
    expect(kpi.data).toEqual({ proposals_created: 2, approved: 1, rejected: 1, applied: 1, recovered_value: 312, waste_avoided_value: 234 })
    expect((await tool('get_approval_status', { proposal_id: 'P-9999' })).status).toBe(404)
    expect((await tool('get_store_stock', {})).status).toBe(400)
  })

  test('3. create_proposal MLK-1L/B2301 47.6 → P-0003 pending, mock- instance, row PENDING', async () => {
    const { status, data } = await tool('create_proposal', proposalFor('MLK-1L', 'B2301', 47.6))
    expect(status).toBe(200)
    expectProposal(data)
    expect(data).toMatchObject({ proposal_id: 'P-0003', status: 'pending', approver_role: 'store_manager',
      old_price: 68, new_price: 47.6, decided_by: null, decided_at: null })
    expect(data.sbpa_instance_id).toMatch(/^mock-/)
    const row = await priceRow('B2301')
    expect(row).toMatchObject({ approval_status: 'PENDING', proposed_price: 47.6, active_proposal_id: 'P-0003',
      sbpa_instance_id: data.sbpa_instance_id, current_price: 68 })
    expect((await request('P-0003')).sbpa_instance_id).toBe(data.sbpa_instance_id)
    p3 = data
  })

  test('4. second create_proposal for B2301 while PENDING → 409, no row, counter unchanged', async () => {
    const before = { count: (await SELECT.from(db().PriceApprovalRequests)).length, counter: await counter() }
    const { status, data } = await tool('create_proposal', proposalFor('MLK-1L', 'B2301', 50))
    expect(status).toBe(409)
    expect(data.error.message).toBe(`Batch B2301 already has an approval in progress (P-0003, ${p3.sbpa_instance_id})`)
    expect((await SELECT.from(db().PriceApprovalRequests)).length).toBe(before.count)
    expect(await counter()).toBe(before.counter)
  })

  test('4b. 400 for new_price >= regular_price or <= 0; 404 for unknown batch', async () => {
    expect((await tool('create_proposal', proposalFor('BAN-12', 'B2306', 60))).status).toBe(400)
    expect((await tool('create_proposal', proposalFor('BAN-12', 'B2306', 0))).status).toBe(400)
    expect((await tool('create_proposal', proposalFor('BAN-12', 'B9999', 50))).status).toBe(404)
    expect(await counter()).toBe(4)
  })

  test('5. concurrency: two parallel create_proposal for B2303 → one 200, one 409', async () => {
    const before = await counter()
    const res = await Promise.all([
      tool('create_proposal', proposalFor('CRS-2PC', 'B2303', 63, { discount_pct: 30 })),
      tool('create_proposal', proposalFor('CRS-2PC', 'B2303', 63, { discount_pct: 30 }))
    ])
    expect(res.map(r => r.status).sort()).toEqual([200, 409])
    expect(await counter()).toBe(before + 1)
    expect((await SELECT.from(db().PriceApprovalRequests).where({ batch: 'B2303' })).length).toBe(1)
    expect((await priceRow('B2303')).approval_status).toBe('PENDING')
  })

  test('6. get_store_stock while pending → MLK-1L price still 68', async () => {
    const { data } = await tool('get_store_stock', { store_id: 'S101' })
    expect(data.items.find(i => i.batch === 'B2301')).toMatchObject({ price: 68, approval_status: 'PENDING', active_proposal_id: 'P-0003' })
  })

  test('7. callback approve → applied; price 47.6; lock cleared; APPLIED', async () => {
    const { status, data } = await callback({ sbpa_instance_id: p3.sbpa_instance_id, decision: 'approve',
      decided_by: 'store.manager@optisell.example', comment: 'ok' })
    expect(status).toBe(200)
    expectProposal(data)
    expect(data).toMatchObject({ proposal_id: 'P-0003', status: 'applied', decided_by: 'store.manager@optisell.example' })
    expect(data.decided_at).toMatch(/Z$/)
    const row = await priceRow('B2301')
    expect(row).toMatchObject({ current_price: 47.6, regular_price: 68, approval_status: 'APPLIED',
      active_proposal_id: null, sbpa_instance_id: null, proposed_price: null, last_decided_by: 'store.manager@optisell.example' })
    expect(row.price_valid_from).toBe(new Date().toISOString().slice(0, 10))
    const stock = await tool('get_store_stock', { store_id: 'S101' })
    expect(stock.data.items.find(i => i.batch === 'B2301').price).toBe(47.6)
  })

  test('8. same callback again → 200, nothing changes', async () => {
    const before = { row: await priceRow('B2301'), req: await request('P-0003') }
    const { status, data } = await callback({ sbpa_instance_id: p3.sbpa_instance_id, decision: 'approve', decided_by: 'someone.else' })
    expect(status).toBe(200)
    expect(data.status).toBe('applied')
    expect(data.decided_by).toBe('store.manager@optisell.example')
    expect(await priceRow('B2301')).toEqual(before.row)
    expect(await request('P-0003')).toEqual(before.req)
  })

  test('9. callback with unknown instance id → 404', async () => {
    const { status, data } = await callback({ sbpa_instance_id: 'does-not-exist', decision: 'approve', decided_by: 'x' })
    expect(status).toBe(404)
    expect(data.error).toBeDefined()
    expect((await callback({ sbpa_instance_id: p3.sbpa_instance_id, decision: 'maybe', decided_by: 'x' })).status).toBe(400)
  })

  test('10. new create_proposal for B2301 after APPLIED → allowed', async () => {
    const { status, data } = await tool('create_proposal', proposalFor('MLK-1L', 'B2301', 40.8, { discount_pct: 40 }))
    expect(status).toBe(200)
    expect(data).toMatchObject({ status: 'pending', old_price: 68 })
    expect((await priceRow('B2301')).approval_status).toBe('PENDING')
    expect((await priceRow('B2301')).current_price).toBe(47.6)
  })

  test('11. YGT-GRK breach → category_manager; reject → price 60, REJECTED, lock cleared', async () => {
    const { data } = await tool('create_proposal', proposalFor('YGT-GRK', 'B2302', 42,
      { margin_breach: true, margin_pct: -19.0, discount_pct: 30, at_risk_qty: 36, reason: 'Expires in 2 days' }))
    expect(data.approver_role).toBe('category_manager')
    const res = await callback({ sbpa_instance_id: data.sbpa_instance_id, decision: 'reject',
      decided_by: 'category.manager@optisell.example', comment: 'Below floor margin' })
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({ status: 'rejected', decided_by: 'category.manager@optisell.example', decision_comment: 'Below floor margin' })
    expect(await priceRow('B2302')).toMatchObject({ current_price: 60, approval_status: 'REJECTED',
      active_proposal_id: null, sbpa_instance_id: null, proposed_price: null })
    // a late approve for the rejected request changes nothing
    expect((await callback({ sbpa_instance_id: data.sbpa_instance_id, decision: 'approve', decided_by: 'x' })).data.status).toBe('rejected')
    expect((await priceRow('B2302')).current_price).toBe(60)
  })

  test('12. SBPA start failure → 502, request failed, row free FAILED', async () => {
    process.env.SBPA_MOCK_FAIL = '1'
    try {
      const { status, data } = await tool('create_proposal', proposalFor('BAN-12', 'B2306', 42))
      expect(status).toBe(502)
      expect(data.error.code).toBe('SBPA_START_FAILED')
      const pid = (await SELECT.one.from(db().PriceApprovalRequests).where({ batch: 'B2306' })).proposal_id
      const r = await request(pid)
      expect(r.status).toBe('failed')
      expect(r.error_message).toMatch(/Mock SBPA start failure/)
      expect(await priceRow('B2306')).toMatchObject({ approval_status: 'FAILED', current_price: 60,
        active_proposal_id: null, sbpa_instance_id: null, proposed_price: null })
    } finally { delete process.env.SBPA_MOCK_FAIL }
    // row is free again
    const retry = await tool('create_proposal', proposalFor('BAN-12', 'B2306', 42))
    expect(retry.status).toBe(200)
  })

  test('13. expire_stale_approvals with a locked row on an expired batch → expired, lock cleared', async () => {
    const { data } = await tool('create_proposal', proposalFor('PNR-200', 'B2310', 76))
    await UPDATE(db().StockBatches).set({ expiry_offset: -1 }).where({ batch: 'B2310' })
    try {
      const res = await call('/admin/expire_stale_approvals', {})
      expect(res.status).toBe(200)
      expect(res.data.expired).toContain(data.proposal_id)
      expect(res.data.expired).not.toContain('P-0005') // B2301 not expired, not stale
      expect((await request(data.proposal_id)).status).toBe('expired')
      expect(await priceRow('B2310')).toMatchObject({ approval_status: 'EXPIRED', current_price: 95,
        active_proposal_id: null, sbpa_instance_id: null, proposed_price: null })
      // a late SBPA callback for the expired request is refused
      expect((await callback({ sbpa_instance_id: data.sbpa_instance_id, decision: 'approve', decided_by: 'x' })).status).toBe(409)
      expect((await priceRow('B2310')).current_price).toBe(95)
    } finally {
      await UPDATE(db().StockBatches).set({ expiry_offset: 3 }).where({ batch: 'B2310' })
    }
  })

  test('13b. stale approvals older than APPROVAL_TIMEOUT_HOURS are expired', async () => {
    const { data } = await tool('create_proposal', proposalFor('TOM-1KG', 'B2311', 34))
    await UPDATE(db().MaterialPrices).set({ approval_requested_at: new Date(Date.now() - 25 * 3600000).toISOString() }).where({ batch: 'B2311' })
    const res = await call('/admin/expire_stale_approvals', {})
    expect(res.data.expired).toEqual([data.proposal_id])
    expect((await priceRow('B2311')).approval_status).toBe('EXPIRED')
  })

  test('14. record_outcome P-0003 110/10 → 5236.0; KPIs recovered 5548.0, waste avoided 2354.0', async () => {
    const { status, data } = await tool('record_outcome', { proposal_id: 'P-0003', units_sold: 110, units_wasted: 10 })
    expect(status).toBe(200)
    expect(data).toEqual({ proposal_id: 'P-0003', recovered_value: 5236.0, recorded: new Date().toISOString().slice(0, 10) })
    const kpi = await tool('get_markdown_kpis', { store_id: 'S101' })
    expect(kpi.data.recovered_value).toBe(5548.0)
    expect(kpi.data.waste_avoided_value).toBe(2354.0)
    expect(kpi.data.applied).toBe(2)
    expect(kpi.data.approved).toBe(2)
    expect((await tool('record_outcome', { proposal_id: 'P-0002', units_sold: 1, units_wasted: 0 })).status).toBe(409)
    expect((await tool('record_outcome', { proposal_id: 'P-9999', units_sold: 1, units_wasted: 0 })).status).toBe(404)
    const props = await tool('get_proposals', { store_id: 'S101', status: 'applied' })
    expect(props.data.proposals.map(p => p.proposal_id)).toEqual(['P-0001', 'P-0003'])
    props.data.proposals.forEach(expectProposal)
    expectProposal((await tool('get_approval_status', { proposal_id: 'P-0003' })).data)
  })

  test('15. /tools rejects a token without Tools scope; /sbpa rejects the agent token', async () => {
    expect((await tool('get_store_stock', { store_id: 'S101' }, NOBODY)).status).toBe(403)
    expect((await tool('get_store_stock', { store_id: 'S101' }, SBPA)).status).toBe(403)
    expect((await callback({ sbpa_instance_id: p3.sbpa_instance_id, decision: 'approve', decided_by: 'x' }, AGENT)).status).toBe(403)
    expect((await callback({ sbpa_instance_id: p3.sbpa_instance_id, decision: 'approve', decided_by: 'x' }, NOBODY)).status).toBe(403)
    const anon = await axios.post('/tools/get_store_stock', { store_id: 'S101' }, { validateStatus: () => true })
    expect(anon.status).toBe(401)
  })

  test('4.5 no client endpoint can set a price', async () => {
    for (const name of ['record_decision', 'update_sales_price'])
      expect((await tool(name, { proposal_id: 'P-0003', new_price: 1 })).status).toBe(404)
    expect((await call('/tools/MaterialPrices', {})).status).toBe(404)
  })

  test('16. all responses are plain JSON (no value / @odata.context)', () => {
    expect(bodies.length).toBeGreaterThan(40)
    for (const b of bodies.filter(b => b.data && typeof b.data === 'object')) {
      expect(b.data).not.toHaveProperty('@odata.context')
      expect(b.data).not.toHaveProperty('value')
    }
  })

  test('@assert.unique sbpa_instance_id: duplicates rejected by the DB, several NULLs allowed', async () => {
    const { PriceApprovalRequests } = db()
    const row = id => ({ proposal_id: id, store_id: 'S101', sku: 'MLK-1L', batch: 'B2301', status: 'failed', sbpa_instance_id: null })
    try {
      // several requests without an instance id (e.g. failed SBPA starts) must be possible
      await cds.db.tx(tx => tx.run(INSERT.into(PriceApprovalRequests).entries([row('U-0001'), row('U-0002')])))
      // a duplicate instance id must be refused by the database itself
      await expect(cds.db.tx(tx => tx.run(INSERT.into(PriceApprovalRequests)
        .entries({ ...row('U-0003'), sbpa_instance_id: p3.sbpa_instance_id })))).rejects.toThrow()
      expect(await SELECT.one.from(PriceApprovalRequests).where({ proposal_id: 'U-0003' })).toBeFalsy()
    } finally {
      await cds.db.tx(tx => tx.run(DELETE.from(PriceApprovalRequests).where({ proposal_id: { like: 'U-%' } })))
    }
  })

  test('startup seeding: skipped when data exists (pending approval survives a restart), loads into an empty DB', async () => {
    const { seedIfEmpty } = require('../srv/lib/seed')
    const pending = (await SELECT.from(db().MaterialPrices).where({ approval_status: 'PENDING' }))
    expect(pending.length).toBeGreaterThan(0)
    expect(await seedIfEmpty()).toBe(false)
    for (const row of pending) expect(await priceRow(row.batch)).toEqual(row)
    expect((await request('P-0003')).status).toBe('applied')

    // empty database → seed loaded (in its own tx, as on a fresh HDI container)
    await cds.db.tx(async tx => { for (const e of Object.values(db())) await tx.run(DELETE.from(e)) })
    expect(await seedIfEmpty()).toBe(true)
    expect(await counter()).toBe(3)
    expect((await SELECT.from(db().MaterialPrices)).length).toBe(11)
  })

  test('reset_demo_data restores the seed', async () => {
    expect((await call('/admin/reset_demo_data', {})).status).toBe(200)
    expect(await counter()).toBe(3)
    expect((await SELECT.from(db().PriceApprovalRequests)).map(r => r.proposal_id)).toEqual(['P-0001', 'P-0002'])
    const rows = await SELECT.from(db().MaterialPrices)
    expect(rows.every(r => r.current_price === (r.batch === 'B2309' ? 24 : r.regular_price))).toBe(true)
    expect(rows.every(r => r.approval_status === (r.batch === 'B2309' ? 'APPLIED' : 'NONE'))).toBe(true)
  })
})
