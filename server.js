const cds = require('@sap/cds')
const { seedIfEmpty } = require('./srv/lib/seed')

// Load the seed only into an EMPTY database. Approvals are asynchronous (SBPA calls back later),
// so a restart must never wipe MaterialPrices / PriceApprovalRequests.
// Use POST /admin/reset_demo_data to reset the demo explicitly.
cds.once('served', () => seedIfEmpty())

module.exports = cds.server
