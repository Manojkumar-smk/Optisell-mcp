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

## Database

| Profile | Database | Seed |
|---|---|---|
| development (`npm run watch`), test (`npm test`) | SQLite in-memory | loaded on every start (DB is empty) |
| production (Cloud Foundry) | SAP HANA Cloud, HDI container `optisell-db` | loaded **once**, only if `MaterialPrices` is empty |
| hybrid (`npm run test:hana`) | HANA, HDI container `optisell-db-test` | test suite against real HANA |

The seed CSVs live in `seed/`, not `db/data/`, so the HDI deployer only creates/migrates tables and never loads or
overwrites data. Pending approvals therefore survive restarts and redeploys. `POST /admin/reset_demo_data` is the only
way to reset the demo.

## SAP HANA Cloud setup (trial)

1. **BTP cockpit → subaccount → Subscriptions:** subscribe to *SAP HANA Cloud* (plan `tools`) and assign yourself the
   role collection *SAP HANA Cloud Administrator*.
2. **SAP HANA Cloud Central → Create instance:** type *SAP HANA Database*, set a DBADMIN password, and under
   *Connections* allow **all IP addresses** (Cloud Foundry and your laptop need to reach it).
3. **Instance mapping:** map the instance to the Cloud Foundry org/space (`3e6e85eetrial_3e6e85eetrial` / `Dev`) so
   `cf marketplace -e hana` lists the `hdi-shared` plan. (In this account it is already done: instance `hanadb`.)
4. **Start the instance every day.** Trial instances are **stopped automatically every night**. Before you use the
   app, deploy, or run `npm run test:hana`, open SAP HANA Cloud Central and click **Start** (takes a few minutes).
   While it is stopped, the app returns HTTP 500 for every tool call, and `cf deploy` fails in the db-deployer.
   Trial instances that stay stopped for 30 days are deleted.
5. Optional, to test against HANA locally:
   ```bash
   cds deploy --to hana:optisell-db-test --profile hybrid   # creates/updates the test container + .cdsrc-private.json
   npm run test:hana                                         # all §7 tests against HANA
   ```

## Deploy (Cloud Foundry)

```bash
cf login -a https://api.cf.us10-001.hana.ondemand.com        # HANA instance must be running (see above)
npm run build          # npm ci → cds build --production → copy seed/ → mbt → mta_archives/optisell-tools_1.0.0.mtar
cf deploy mta_archives/optisell-tools_1.0.0.mtar
cf create-service-key optisell-agent-uaa agent-key   # credentials for Joule Studio
cf create-service-key optisell-sbpa-uaa  sbpa-key    # credentials for the SBPA destination
cf app optisell-tools-srv                            # → routes: the app base URL
npm run openapi -- https://<app base URL>            # tokenUrl is read from the agent-key service key
```

Smoke test against the deployed app (client-credentials tokens from the two service keys):

```bash
tok () { cf service-key "$1" "$2" | sed -n '/{/,$p' | jq -r '.credentials // . | "\(.url)/oauth/token \(.clientid) \(.clientsecret)"' |
         { read u i s; curl -s -u "$i:$s" -d grant_type=client_credentials "$u" | jq -r .access_token; }; }
BASE_URL=https://<app base URL> AGENT_TOKEN=$(tok optisell-agent-uaa agent-key) SBPA_TOKEN=$(tok optisell-sbpa-uaa sbpa-key) \
  ./scripts/smoke.sh
```

The agent and SBPA use separate XSUAA instances because all keys of a single XSUAA instance share one client and its
authorities; `grant-as-authority-to-apps` in `xs-security.json` grants each client exactly one scope.

## Values for Joule Studio

| Field | Where it comes from | Value |
|---|---|---|
| App base URL | `cf app optisell-tools-srv` → routes | `https://3e6e85eetrial-3e6e85eetrial-dev-optisell-tools-srv.cfapps.us10-001.hana.ondemand.com` |
| MCP / OpenAPI server URL | app base URL + `/tools` | `https://3e6e85eetrial-3e6e85eetrial-dev-optisell-tools-srv.cfapps.us10-001.hana.ondemand.com/tools` |
| Token URL | `url` of the `optisell-agent-uaa` key + `/oauth/token` | `https://3e6e85eetrial.authentication.us10.hana.ondemand.com/oauth/token` |
| Client ID | `cf service-key optisell-agent-uaa agent-key` → `clientid` | `sb-optisell-agent!t736114` |
| Client secret | `cf service-key optisell-agent-uaa agent-key` → `clientsecret` | *not stored in this repo — read it with the command* |

## OpenAPI (Joule Studio MCP server)

`npm run openapi -- <app base URL>` = `cds compile srv/tools-service.cds --to openapi` + servers URL, OAuth2 scheme
(tokenUrl from the agent service key), required params, and `[read-only]`/`[write]` markers. It refuses to write
placeholders or an app/token region mismatch. Contains only the 10 `/tools` operations — no `/sbpa`, no `/admin`.
