const cds = require('@sap/cds')
const { resetDemoData } = require('./srv/lib/seed')

// Load the seed (with date offsets resolved to today) once the services are up.
cds.once('served', () => resetDemoData())

module.exports = cds.server
