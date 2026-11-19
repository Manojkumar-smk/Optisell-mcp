# OptiSell Tools Service (CAP)

Built from `OPTISELL_CAP_MCP_BRIEF.md`. CAP Node.js app on SAP BTP that serves the OptiSell agent tools as plain-JSON REST
and runs price approvals asynchronously through SAP Build Process Automation (SBPA).

| Path | Who calls it | Scope |
|---|---|---|
| `POST /tools/<tool>` | Joule Studio agent / MCP server | `Tools` |
| `POST /sbpa/complete_approval` | SBPA only (final action of the process) | `SbpaCallback` |
| `POST /admin/reset_demo_data`, `/admin/expire_stale_approvals` | demo operator | `Tools` |

`MaterialPrices.current_price` changes **only** in `/sbpa/complete_approval`, and only to the price stored in the request.

## Run locally

```bash
npm install
npm test                 # §7 acceptance tests (SBPA_MODE=mock)
npm run watch            # http://localhost:4004, mocked users: agent (Tools), sbpa (SbpaCallback), nobody
./scripts/smoke.sh       # end-to-end flow against the running server
```

## Configuration

| Variable | Default | |
|---|---|---|
| `SBPA_MODE` | `mock` | `mock` → `mock-<uuid>` instance IDs, no network; `live` → calls SBPA |
| `SBPA_MOCK_FAIL` | – | `1` makes the mock start fail (502 path) |
| `SBPA_API_URL` | – | e.g. `https://spa-api-gateway-bpi-us-prod.cfapps.us10.hana.ondemand.com` → `/workflow/rest/v1/workflow-instances` is appended |
| `SBPA_TRIGGER_URL` | – | full trigger URL (overrides `SBPA_API_URL`) |
| `SBPA_TOKEN_URL`, `SBPA_CLIENT_ID`, `SBPA_CLIENT_SECRET` | – | OAuth2 client credentials of the SBPA service key |
| `SBPA_DEFINITION_ID` | – | process definition ID of the API trigger |
| `APPROVAL_TIMEOUT_HOURS` | `24` | used by `expire_stale_approvals` |

## Deploy (Cloud Foundry)

```bash
npm run build                                   # mbt build → mta_archives/optisell-tools_1.0.0.mtar
cf deploy mta_archives/optisell-tools_1.0.0.mtar
cf create-service-key optisell-agent-uaa agent-key   # credentials for Joule Studio
cf create-service-key optisell-sbpa-uaa  sbpa-key    # credentials for the SBPA destination
npm run openapi -- https://<app-url>              # openapi/optisell-tools.openapi.json with the real server URL
```

The agent and SBPA use separate XSUAA instances because all keys of a single XSUAA instance share one client and its
authorities; `grant-as-authority-to-apps` in `xs-security.json` grants each client exactly one scope.

**POC limitation:** the database is in-memory SQLite (one instance). Every restart / restage reloads the seed, and
open approvals are lost — SBPA callbacks for them then get 404.

## OpenAPI (Joule Studio MCP server)

`npm run openapi` = `cds compile srv/tools-service.cds --to openapi` + servers URL, OAuth2 scheme, required params, and
`[read-only]`/`[write]` markers. Contains only the 10 `/tools` operations — no `/sbpa`, no `/admin`.
