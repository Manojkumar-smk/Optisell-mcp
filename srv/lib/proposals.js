// Proposal object (§4.1) — the 14 required fields plus extras.
const cds = require('@sap/cds')
const { fmtTimestamp } = require('./dates')

function toProposal (r) {
  return {
    proposal_id: r.proposal_id,
    store_id: r.store_id,
    sku: r.sku,
    batch: r.batch,
    old_price: r.old_price,
    new_price: r.new_price,
    discount_pct: r.discount_pct,
    margin_pct: r.margin_pct,
    margin_breach: !!r.margin_breach,
    at_risk_qty: r.at_risk_qty,
    reason: r.reason,
    status: r.status,
    approver_role: r.approver_role,
    created: r.created,
    // extras
    sbpa_instance_id: r.sbpa_instance_id ?? null,
    sbpa_definition_id: r.sbpa_definition_id ?? null,
    requested_by: r.requested_by ?? null,
    requested_at: fmtTimestamp(r.requested_at),
    decided_by: r.decided_by ?? null,
    decided_at: fmtTimestamp(r.decided_at),
    applied_at: fmtTimestamp(r.applied_at),
    decision_comment: r.decision_comment ?? null,
    error_message: r.error_message ?? null
  }
}

async function readProposal (tx, proposal_id) {
  const { PriceApprovalRequests } = cds.entities('optisell')
  const r = await (tx || cds.db).run(SELECT.one.from(PriceApprovalRequests).where({ proposal_id }))
  return r ? toProposal(r) : null
}

/** Error with HTTP status + code that CAP renders as {"error": {"code", "message"}} */
function httpError (status, message, code) {
  const e = new Error(message)
  e.status = status; e.statusCode = status
  e.code = code || { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT', 502: 'BAD_GATEWAY' }[status] || String(status)
  return e
}

module.exports = { toProposal, readProposal, httpError }
