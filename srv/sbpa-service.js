// SBPA callback — the ONLY code path that changes MaterialPrices.current_price.
const cds = require('@sap/cds')
const { today, now } = require('./lib/dates')
const lock = require('./lib/price-lock')
const { toProposal, httpError } = require('./lib/proposals')
const LOG = cds.log('sbpa')

module.exports = class SbpaService extends cds.ApplicationService {
  init () {
    const { MaterialPrices, PriceApprovalRequests } = cds.entities('optisell')

    this.on('complete_approval', async req => {
      const { sbpa_instance_id, decided_by } = req.data
      const decision = String(req.data.decision || '').toLowerCase()
      const comment = req.data.comment ?? null
      if (!sbpa_instance_id) throw httpError(400, 'sbpa_instance_id is required')
      if (!decided_by) throw httpError(400, 'decided_by is required')
      if (!['approve', 'reject'].includes(decision)) throw httpError(400, "decision must be 'approve' or 'reject'")

      const proposal_id = await cds.db.tx(async tx => {
        // 1. find the request
        const r = await tx.run(SELECT.one.from(PriceApprovalRequests).where({ sbpa_instance_id }))
        if (!r) throw httpError(404, `No approval request for SBPA instance ${sbpa_instance_id}`)

        // 2. idempotent for already decided requests (SBPA may retry)
        if (r.status === 'applied' || r.status === 'rejected') {
          LOG.info('callback for already decided', r.proposal_id, `(${r.status}) — no change`)
          return r.proposal_id
        }

        // 3. the price row must be PENDING with the same instance id
        const key = { store_id: r.store_id, sku: r.sku, batch: r.batch }
        const mp = await tx.run(SELECT.one.from(MaterialPrices).where(key))
        if (r.status !== 'pending' || !mp || mp.approval_status !== 'PENDING' || mp.sbpa_instance_id !== sbpa_instance_id) {
          LOG.warn('callback rejected for', r.proposal_id, { request_status: r.status, row_status: mp?.approval_status,
            row_instance: mp?.sbpa_instance_id, callback_instance: sbpa_instance_id })
          throw httpError(409, `Request ${r.proposal_id} is ${r.status}; batch ${r.batch} is ${mp?.approval_status} ` +
            `with instance ${mp?.sbpa_instance_id ?? 'none'} — callback for ${sbpa_instance_id} not applied`)
        }

        const ts = now()
        const decisionFields = { decided_by, decided_at: ts, decision_comment: comment }
        const rowDecision = { approval_decided_at: ts, last_decided_by: decided_by }
        let n
        if (decision === 'approve') {
          // 4. price comes from the stored request, never from the callback
          n = await tx.run(UPDATE(MaterialPrices)
            .set({ current_price: r.new_price, price_valid_from: today(), approval_status: 'APPLIED',
                   active_proposal_id: null, sbpa_instance_id: null, proposed_price: null, ...rowDecision })
            .where({ ...key, approval_status: 'PENDING', sbpa_instance_id }))
          if (n) await tx.run(UPDATE(PriceApprovalRequests).set({ status: 'applied', applied_at: ts, ...decisionFields })
            .where({ proposal_id: r.proposal_id, status: 'pending' }))
        } else {
          // 5. reject — price unchanged
          n = await tx.run(UPDATE(MaterialPrices)
            .set({ approval_status: 'REJECTED', active_proposal_id: null, sbpa_instance_id: null, proposed_price: null, ...rowDecision })
            .where({ ...key, approval_status: 'PENDING', sbpa_instance_id }))
          if (n) await tx.run(UPDATE(PriceApprovalRequests).set({ status: 'rejected', ...decisionFields })
            .where({ proposal_id: r.proposal_id, status: 'pending' }))
        }
        if (!n) throw httpError(409, `Batch ${r.batch} changed concurrently — callback for ${sbpa_instance_id} not applied`)
        LOG.info(r.proposal_id, decision === 'approve' ? `applied ${r.old_price} → ${r.new_price}` : 'rejected', 'by', decided_by)
        return r.proposal_id
      })

      return toProposal(await SELECT.one.from(PriceApprovalRequests).where({ proposal_id }))
    })

    return super.init()
  }
}
