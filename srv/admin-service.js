const cds = require('@sap/cds')
const { now } = require('./lib/dates')
const lock = require('./lib/price-lock')
const { resetDemoData } = require('./lib/seed')
const LOG = cds.log('admin')

module.exports = class AdminService extends cds.ApplicationService {
  init () {
    const { MaterialPrices, PriceApprovalRequests, StockBatches } = cds.entities('optisell')

    this.on('reset_demo_data', async () => {
      await resetDemoData()
      return { reset: true, next_proposal: 'P-0003' }
    })

    this.on('expire_stale_approvals', async () => {
      const hours = Number(process.env.APPROVAL_TIMEOUT_HOURS) || 24
      const cutoff = Date.now() - hours * 3600000
      // NOTE: all DB access goes through explicit cds.db.tx — the in-memory SQLite pool has ONE connection,
      // so mixing the request's own tx with a separate tx in the same handler would deadlock.
      const { locked, expiry } = await cds.db.tx(async tx => ({
        locked: await tx.run(SELECT.from(MaterialPrices).where({ approval_status: { in: lock.LOCKED } })),
        expiry: new Map((await tx.run(SELECT.from(StockBatches).columns('batch', 'expiry_offset'))).map(b => [b.batch, b.expiry_offset]))
      }))
      const expired = []
      for (const mp of locked) {
        const batchExpired = (expiry.get(mp.batch) ?? 0) < 0
        const tooOld = mp.approval_requested_at && Date.parse(mp.approval_requested_at) < cutoff
        if (!batchExpired && !tooOld) continue
        const why = batchExpired ? `batch ${mp.batch} expired` : `no SBPA decision within ${hours} h`
        const key = { store_id: mp.store_id, sku: mp.sku, batch: mp.batch }
        const pid = mp.active_proposal_id
        await cds.db.tx(async tx => {
          const n = await lock.release(tx, key, pid, 'EXPIRED', { approval_decided_at: now() })
          if (!n) return // decided concurrently
          await tx.run(UPDATE(PriceApprovalRequests).set({ status: 'expired', error_message: `Expired: ${why}` })
            .where({ proposal_id: pid, status: 'pending' }))
          expired.push(pid)
        })
        LOG.info('expired', pid, '—', why)
      }
      return { expired }
    })

    return super.init()
  }
}
