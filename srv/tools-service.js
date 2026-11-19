const cds = require('@sap/cds')
const { today, offsetToDate, now } = require('./lib/dates')
const lock = require('./lib/price-lock')
const sbpa = require('./lib/sbpa-client')
const { toProposal, readProposal, httpError } = require('./lib/proposals')
const LOG = cds.log('tools')

const STATUSES = ['pending', 'applied', 'rejected', 'failed', 'expired']
const round2 = x => Math.round(x * 100) / 100

function intParam (v, name, dflt) {
  if (v === undefined || v === null) return dflt
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw httpError(400, `${name} must be a non-negative integer`)
  return n
}
function numParam (v, name) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw httpError(400, `${name} must be a number`)
  return n
}
function strParam (v, name) {
  if (typeof v !== 'string' || !v.trim()) throw httpError(400, `${name} is required`)
  return v.trim()
}

module.exports = class ToolsService extends cds.ApplicationService {
  init () {
    const { StockBatches, MaterialPrices, SalesDaily, Forecast, Events, MarkdownPolicies, CompetitorPrices,
      Counters, PriceApprovalRequests, Outcomes } = cds.entities('optisell')

    // ---- Tool 1 -------------------------------------------------------------------------------
    this.on('get_store_stock', async req => {
      const store_id = strParam(req.data.store_id, 'store_id')
      const horizon = intParam(req.data.horizon_days, 'horizon_days', 7)
      const t = today()
      const batches = await SELECT.from(StockBatches).where({ store_id, expiry_offset: { '<=': horizon } })
        .orderBy('expiry_offset', 'sku', 'batch')
      const prices = new Map((await SELECT.from(MaterialPrices).where({ store_id })).map(p => [`${p.sku}|${p.batch}`, p]))
      return {
        store_id, currency: 'INR',
        items: batches.map(b => {
          const p = prices.get(`${b.sku}|${b.batch}`) || {}
          return {
            sku: b.sku, name: b.name, category: b.category, batch: b.batch, qty: b.qty,
            expiry: offsetToDate(b.expiry_offset, t), unit_cost: b.unit_cost,
            price: p.current_price ?? null,
            approval_status: p.approval_status ?? 'NONE',
            active_proposal_id: p.active_proposal_id ?? null
          }
        })
      }
    })

    // ---- Tool 2 -------------------------------------------------------------------------------
    this.on('get_sales_history', async req => {
      const store_id = strParam(req.data.store_id, 'store_id')
      const days = intParam(req.data.days, 'days', 14)
      const t = today()
      const where = { store_id, day_offset: { between: -days, and: -1 } }
      if (req.data.sku) where.sku = req.data.sku
      const rows = await SELECT.from(SalesDaily).where(where).orderBy('sku', 'day_offset')
      return {
        store_id,
        from_date: offsetToDate(-days + 1, t),
        to_date: t,
        sales: rows.map(r => ({ sku: r.sku, date: offsetToDate(r.day_offset, t), units: r.units }))
      }
    })

    // ---- Tool 3 -------------------------------------------------------------------------------
    this.on('get_demand_signals', async req => {
      const store_id = strParam(req.data.store_id, 'store_id')
      const horizon = intParam(req.data.horizon_days, 'horizon_days', 7)
      const t = today()
      const forecast = await SELECT.from(Forecast).where({ store_id }).orderBy('sku')
      const events = await SELECT.from(Events).where({ store_id, day_offset: { between: 0, and: horizon } }).orderBy('day_offset')
      return {
        forecast: forecast.map(f => ({ sku: f.sku, daily_units: f.daily_units })),
        events: events.map(e => ({
          name: e.name, date: offsetToDate(e.day_offset, t), impact_pct: e.impact_pct,
          categories: (e.categories || '').split(',').map(s => s.trim()).filter(Boolean)
        }))
      }
    })

    // ---- Tool 4 -------------------------------------------------------------------------------
    this.on('get_markdown_policy', async req => {
      const category = strParam(req.data.category, 'category')
      const p = await SELECT.one.from(MarkdownPolicies).where({ category })
      if (!p) throw httpError(404, `No markdown policy for category ${category}`)
      return p
    })

    // ---- Tool 5 -------------------------------------------------------------------------------
    this.on('get_competitor_prices', async req => {
      strParam(req.data.store_id, 'store_id')
      const sku = strParam(req.data.sku, 'sku')
      const t = today()
      const rows = await SELECT.from(CompetitorPrices).where({ sku }).orderBy('name')
      return { sku, competitor_prices: rows.map(r => ({ name: r.name, price: r.price, observed: offsetToDate(r.observed_offset, t) })) }
    })

    // ---- Tool 6: create_proposal → start SBPA ------------------------------------------------
    this.on('create_proposal', async req => {
      const d = req.data
      const key = { store_id: strParam(d.store_id, 'store_id'), sku: strParam(d.sku, 'sku'), batch: strParam(d.batch, 'batch') }
      const new_price = numParam(d.new_price, 'new_price')
      const discount_pct = numParam(d.discount_pct, 'discount_pct')
      const margin_pct = numParam(d.margin_pct, 'margin_pct')
      const at_risk_qty = numParam(d.at_risk_qty, 'at_risk_qty')
      if (typeof d.margin_breach !== 'boolean') throw httpError(400, 'margin_breach must be a boolean')
      const reason = strParam(d.reason, 'reason')
      const requested_by = d.requested_by || req.user?.id || 'unknown'
      const ts = now()

      // Steps 1–3 in ONE transaction: a failed lock rolls back the request row and the counter.
      const { proposal, mp } = await cds.db.tx(async tx => {
        const mp = await tx.run(SELECT.one.from(MaterialPrices).where(key))
        if (!mp) throw httpError(404, `Unknown sku/batch ${key.sku}/${key.batch} in store ${key.store_id}`)
        if (new_price <= 0 || new_price >= mp.regular_price)
          throw httpError(400, `new_price must be > 0 and < regular_price ${mp.regular_price}`)

        // Fast path for a clear error message; the atomic UPDATE below is the actual guard.
        if (lock.isLocked(mp)) throw conflict(key.batch, mp)

        const c = await tx.run(SELECT.one.from(Counters).where({ name: 'proposal' }))
        const seq = c?.value ?? 3
        const proposal_id = `P-${String(seq).padStart(4, '0')}`
        if (c) await tx.run(UPDATE(Counters).set({ value: seq + 1 }).where({ name: 'proposal' }))
        else await tx.run(INSERT.into(Counters).entries({ name: 'proposal', value: seq + 1 }))

        const proposal = {
          proposal_id, ...key,
          old_price: mp.regular_price, // ignore client-supplied old_price
          new_price, discount_pct, margin_pct, margin_breach: d.margin_breach, at_risk_qty, reason,
          approver_role: d.margin_breach ? 'category_manager' : 'store_manager',
          status: 'pending', sbpa_instance_id: null, requested_by, created: today(), requested_at: ts
        }
        await tx.run(INSERT.into(PriceApprovalRequests).entries(proposal))

        const n = await lock.acquire(tx, key, { proposal_id, new_price, now: ts })
        if (n === 0) throw conflict(key.batch, await tx.run(SELECT.one.from(MaterialPrices).where(key)))
        return { proposal, mp }
      })

      // Step 4: start SBPA outside the DB transaction (row is TRIGGERING ⇒ locked meanwhile).
      const context = {
        proposal_id: proposal.proposal_id, store_id: key.store_id, sku: key.sku, batch: key.batch,
        old_price: mp.regular_price, new_price, discount_pct, margin_pct, margin_breach: proposal.margin_breach,
        approver_role: proposal.approver_role, reason, at_risk_qty
      }
      let started, failure
      try { started = await sbpa.startApproval(context) } catch (e) { failure = e }

      if (failure) {
        // Step 6: request failed, lock released with status FAILED.
        LOG.error('SBPA start failed for', proposal.proposal_id, failure.message)
        await cds.db.tx(async tx => {
          await tx.run(UPDATE(PriceApprovalRequests).set({ status: 'failed', error_message: String(failure.message).slice(0, 1000) })
            .where({ proposal_id: proposal.proposal_id }))
          await lock.release(tx, key, proposal.proposal_id, 'FAILED')
        })
        throw httpError(502, `SBPA process could not be started for ${proposal.proposal_id}: ${failure.message}`, 'SBPA_START_FAILED')
      }

      // Step 5: store the instance id on both tables, row → PENDING.
      await cds.db.tx(async tx => {
        await tx.run(UPDATE(PriceApprovalRequests)
          .set({ sbpa_instance_id: started.instanceId, sbpa_definition_id: started.definitionId })
          .where({ proposal_id: proposal.proposal_id }))
        const n = await lock.markPending(tx, key, proposal.proposal_id, started.instanceId)
        if (n === 0) LOG.warn('lock for', proposal.proposal_id, 'was no longer TRIGGERING when SBPA returned', started.instanceId)
      })
      return readProposal(null, proposal.proposal_id)
    })

    // ---- Tool 7 -------------------------------------------------------------------------------
    this.on('get_proposals', async req => {
      const store_id = strParam(req.data.store_id, 'store_id')
      const where = { store_id }
      if (req.data.status) {
        const status = String(req.data.status).toLowerCase()
        if (!STATUSES.includes(status)) throw httpError(400, `status must be one of ${STATUSES.join(', ')}`)
        where.status = status
      }
      const rows = await SELECT.from(PriceApprovalRequests).where(where).orderBy('proposal_id')
      return { proposals: rows.map(toProposal) }
    })

    // ---- Tool 8 -------------------------------------------------------------------------------
    this.on('get_approval_status', async req => {
      const proposal_id = strParam(req.data.proposal_id, 'proposal_id')
      const p = await readProposal(null, proposal_id)
      if (!p) throw httpError(404, `Unknown proposal ${proposal_id}`)
      return p
    })

    // ---- Tool 10 ------------------------------------------------------------------------------
    this.on('record_outcome', async req => {
      const proposal_id = strParam(req.data.proposal_id, 'proposal_id')
      const units_sold = numParam(req.data.units_sold, 'units_sold')
      const units_wasted = numParam(req.data.units_wasted, 'units_wasted')
      if (units_sold < 0 || units_wasted < 0) throw httpError(400, 'units_sold and units_wasted must be >= 0')
      const r = await SELECT.one.from(PriceApprovalRequests).where({ proposal_id })
      if (!r) throw httpError(404, `Unknown proposal ${proposal_id}`)
      if (r.status !== 'applied') throw httpError(409, `Proposal ${proposal_id} has status ${r.status}; outcomes can only be recorded for applied proposals`)
      const outcome = { proposal_id, units_sold, units_wasted, recovered_value: round2(units_sold * r.new_price), recorded: today() }
      await UPSERT.into(Outcomes).entries(outcome)
      return { proposal_id, recovered_value: outcome.recovered_value, recorded: outcome.recorded }
    })

    // ---- Tool 11 ------------------------------------------------------------------------------
    this.on('get_markdown_kpis', async req => {
      const store_id = strParam(req.data.store_id, 'store_id')
      const requests = await SELECT.from(PriceApprovalRequests).where({ store_id })
      const byId = new Map(requests.map(r => [r.proposal_id, r]))
      const outcomes = (await SELECT.from(Outcomes)).filter(o => byId.has(o.proposal_id))
      const costs = new Map((await SELECT.from(StockBatches).columns('batch', 'unit_cost').where({ store_id })).map(b => [b.batch, b.unit_cost]))
      const count = s => requests.filter(r => r.status === s).length
      let recovered = 0, avoided = 0
      for (const o of outcomes) {
        const r = byId.get(o.proposal_id)
        recovered += o.recovered_value || 0
        avoided += Math.max(0, (r.at_risk_qty || 0) - (o.units_wasted || 0)) * (costs.get(r.batch) || 0)
      }
      return {
        proposals_created: requests.length,
        approved: count('applied'),
        rejected: count('rejected'),
        applied: count('applied'),
        recovered_value: round2(recovered),
        waste_avoided_value: round2(avoided)
      }
    })

    return super.init()
  }
}

function conflict (batch, mp) {
  return httpError(409, `Batch ${batch} already has an approval in progress (${mp?.active_proposal_id}, ${mp?.sbpa_instance_id})`)
}
