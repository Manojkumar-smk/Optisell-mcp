// MaterialPrices doubles as the approval lock (§3.2 / §3.5).
//   Locked ⇔ approval_status ∈ {TRIGGERING, PENDING}
//   Free   ⇔ any other status; lock fields (active_proposal_id, sbpa_instance_id, proposed_price) are null
const cds = require('@sap/cds')

const LOCKED = ['TRIGGERING', 'PENDING']
const isLocked = row => !!row && LOCKED.includes(row.approval_status)
const CLEARED = { active_proposal_id: null, sbpa_instance_id: null, proposed_price: null }

/**
 * Atomically acquire the lock with ONE conditional UPDATE and return the affected-row count.
 * 0 ⇒ the row is already locked (or does not exist).
 */
async function acquire (tx, { store_id, sku, batch }, { proposal_id, new_price, now }) {
  const { MaterialPrices } = cds.entities('optisell')
  return tx.run(
    UPDATE(MaterialPrices)
      .set({ approval_status: 'TRIGGERING', active_proposal_id: proposal_id, proposed_price: new_price,
             sbpa_instance_id: null, approval_requested_at: now })
      .where({ store_id, sku, batch, approval_status: { 'not in': LOCKED } })
  )
}

/** TRIGGERING → PENDING once SBPA returned the process instance id. */
async function markPending (tx, key, proposal_id, sbpa_instance_id) {
  const { MaterialPrices } = cds.entities('optisell')
  return tx.run(
    UPDATE(MaterialPrices).set({ approval_status: 'PENDING', sbpa_instance_id })
      .where({ ...key, active_proposal_id: proposal_id, approval_status: 'TRIGGERING' })
  )
}

/**
 * Release the lock held by proposal_id, leaving `status` as last outcome.
 * `extra` may carry price / decision fields. Returns affected-row count.
 */
async function release (tx, key, proposal_id, status, extra = {}) {
  const { MaterialPrices } = cds.entities('optisell')
  return tx.run(
    UPDATE(MaterialPrices).set({ ...extra, approval_status: status, ...CLEARED })
      .where({ ...key, active_proposal_id: proposal_id, approval_status: { in: LOCKED } })
  )
}

module.exports = { LOCKED, isLocked, acquire, markPending, release }
