// Starts an SBPA approval process instance.
//   SBPA_MODE=mock (default): returns mock-<uuid>, no network call.
//                             SBPA_MOCK_FAIL=1 makes the mock throw (used by tests / demos).
//   SBPA_MODE=live: POST {SBPA_API_URL}/workflow/rest/v1/workflow-instances
//                   (or SBPA_TRIGGER_URL as full URL) with OAuth2 client credentials.
const cds = require('@sap/cds')
const { randomUUID } = require('crypto')
const LOG = cds.log('sbpa')

const env = k => process.env[k]
const mode = () => (env('SBPA_MODE') || 'mock').toLowerCase()
const definitionId = () => env('SBPA_DEFINITION_ID') || (mode() === 'mock' ? 'mock.optisell.priceapproval' : undefined)

let token // { value, exp }
async function getToken () {
  if (token && token.exp > Date.now() + 30000) return token.value
  for (const k of ['SBPA_TOKEN_URL', 'SBPA_CLIENT_ID', 'SBPA_CLIENT_SECRET'])
    if (!env(k)) throw new Error(`${k} is not set`)
  let url = env('SBPA_TOKEN_URL')
  if (!/\/oauth\/token\/?$/.test(url)) url = url.replace(/\/$/, '') + '/oauth/token'
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${env('SBPA_CLIENT_ID')}:${env('SBPA_CLIENT_SECRET')}`).toString('base64')
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(`SBPA token request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  const body = await res.json()
  token = { value: body.access_token, exp: Date.now() + (body.expires_in || 600) * 1000 }
  return token.value
}

/**
 * @param {object} context — proposal_id, store_id, sku, batch, old_price, new_price, discount_pct,
 *                           margin_pct, margin_breach, approver_role, reason, at_risk_qty
 * @returns {Promise<{instanceId: string, definitionId: string}>}
 */
async function startApproval (context) {
  if (mode() === 'mock') {
    if (env('SBPA_MOCK_FAIL') === '1') throw new Error('Mock SBPA start failure (SBPA_MOCK_FAIL=1)')
    const instanceId = `mock-${randomUUID()}`
    LOG.info('mock SBPA start', context.proposal_id, '→', instanceId)
    return { instanceId, definitionId: definitionId() }
  }
  if (mode() !== 'live') throw new Error(`Unknown SBPA_MODE '${mode()}' (expected mock|live)`)
  const defId = definitionId()
  if (!defId) throw new Error('SBPA_DEFINITION_ID is not set')
  const url = env('SBPA_TRIGGER_URL') ||
    (env('SBPA_API_URL') ? env('SBPA_API_URL').replace(/\/$/, '') + '/workflow/rest/v1/workflow-instances' : null)
  if (!url) throw new Error('SBPA_API_URL (or SBPA_TRIGGER_URL) is not set')

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` },
    body: JSON.stringify({ definitionId: defId, context }),
    signal: AbortSignal.timeout(20000)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SBPA start failed: HTTP ${res.status} ${text.slice(0, 500)}`)
  let body; try { body = JSON.parse(text) } catch { throw new Error('SBPA start returned non-JSON response') }
  if (!body.id) throw new Error('SBPA start response has no instance id')
  LOG.info('SBPA started', context.proposal_id, '→', body.id)
  return { instanceId: body.id, definitionId: body.definitionId || defId }
}

module.exports = { startApproval, mode }
