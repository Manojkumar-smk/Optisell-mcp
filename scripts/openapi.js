#!/usr/bin/env node
// Equivalent of `cds compile srv/tools-service.cds --to openapi`, plus:
//  - servers → deployed URL (OPENAPI_SERVER_URL or first CLI arg)
//  - OAuth2 client-credentials security scheme (XSUAA)
//  - read-only / write hints per tool
// Only ToolsService — /sbpa and /admin are intentionally NOT included.
const cds = require('@sap/cds')
const { compile: toOpenapi } = require('@cap-js/openapi')
const fs = require('fs'), path = require('path')

const READ_ONLY = ['get_store_stock', 'get_sales_history', 'get_demand_signals', 'get_markdown_policy',
  'get_competitor_prices', 'get_proposals', 'get_approval_status', 'get_markdown_kpis']
const WRITES = ['create_proposal', 'record_outcome']

;(async () => {
  const server = process.argv[2] || process.env.OPENAPI_SERVER_URL || 'https://<your-app>.cfapps.us10-001.hana.ondemand.com'
  const tokenUrl = process.env.OPENAPI_TOKEN_URL || 'https://<subdomain>.authentication.us10.hana.ondemand.com/oauth/token'
  const csn = await cds.load(path.join(__dirname, '..', 'srv', 'tools-service.cds'), { docs: true })
  const doc = toOpenapi(csn, { service: 'ToolsService', 'openapi:url': '/tools', 'openapi:diagram': false })

  doc.servers = [{ url: server.replace(/\/$/, '') + '/tools' }]
  doc.info.title = 'OptiSell Tools'
  doc.info.version = require('../package.json').version
  doc.components ??= {}
  doc.components.securitySchemes = {
    xsuaa: { type: 'oauth2', flows: { clientCredentials: { tokenUrl, scopes: {} } } }
  }
  doc.security = [{ xsuaa: [] }]

  const ops = Object.keys(doc.paths)
  for (const p of ops) {
    const name = p.replace(/^\//, '')
    if (![...READ_ONLY, ...WRITES].includes(name)) { delete doc.paths[p]; continue }
    const op = doc.paths[p].post
    op.operationId = name
    const ro = READ_ONLY.includes(name)
    op['x-read-only'] = ro
    // mark `not null` action parameters as required
    const params = csn.definitions[`ToolsService.${name}`]?.params || {}
    const required = Object.entries(params).filter(([, d]) => d.notNull).map(([k]) => k)
    const schema = op.requestBody?.content?.['application/json']?.schema
    if (schema && required.length) schema.required = required
    const docText = csn.definitions[`ToolsService.${name}`]?.doc
    if (docText) op.description = docText
    op.summary = (ro ? '[read-only] ' : '[write] ') + name
  }
  // REST returns doubles as JSON numbers — drop the OData IEEE754 "number | string" union
  const fixNumbers = o => {
    if (Array.isArray(o)) return o.forEach(fixNumbers)
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o.anyOf) && o.anyOf.length === 2 && o.anyOf[0].type === 'number' && o.anyOf[1].type === 'string') {
      Object.assign(o, o.anyOf[0]); delete o.anyOf; delete o.example
    }
    Object.values(o).forEach(fixNumbers)
  }
  fixNumbers(doc)

  const names = Object.keys(doc.paths).map(p => p.slice(1)).sort()
  const expected = [...READ_ONLY, ...WRITES].sort()
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('unexpected tool set: ' + names.join(', '))

  const out = path.join(__dirname, '..', 'openapi', 'optisell-tools.openapi.json')
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
  console.log(`wrote ${out} — ${names.length} tools, server ${doc.servers[0].url}`)
})().catch(e => { console.error(e); process.exit(1) })
