# OptiSell Tools Service — build brief for Claude Code (v2: SBPA approval)

Build a **CAP Node.js** application for SAP BTP (trial account) that:
1. serves the OptiSell tools as plain JSON REST endpoints (backend for an existing Joule Studio
   agent and for a Joule Studio MCP server via OpenAPI translation), and
2. runs price approvals **asynchronously through SAP Build Process Automation (SBPA)**:
   the agent requests a price change, CAP starts an SBPA process, and the price is updated
   **only by CAP when SBPA calls back with an approval**.

**The agent validates every response with strict Pydantic models, so field names, types and
shapes below are a binding contract.** Extra fields are allowed; missing or renamed fields are not.

Purpose: proof of concept, mock retail data for one store (S101, currency INR).

---

## 1. Tech and conventions

- Node.js 22, `@sap/cds` ^10, `@cap-js/sqlite` ^3 (locally and in production on CF)
- Auth: XSUAA, OAuth2 client credentials
- Services:
  - `/tools` — agent-facing tools, protocol **REST**, `POST /tools/<tool_name>`, JSON body of named parameters
  - `/sbpa` — called **only by SBPA** (approval callback), protocol REST
  - `/admin` — demo reset
- Responses are plain JSON (no `value`, no `@odata.context`)
- Prices/amounts as JSON numbers (`Double`, not `Decimal`), counts as integers,
  booleans `true/false`, dates `"YYYY-MM-DD"`, timestamps `"YYYY-MM-DDTHH:MM:SSZ"` (UTC)
- snake_case names exactly as written

## 2. Project structure

```
optisell-tools/
├── package.json
├── xs-security.json
├── mta.yaml
├── db/
│   ├── schema.cds
│   └── data/                       # CSV seed (§5) — offsets, never absolute dates
├── srv/
│   ├── tools-service.cds / .js     # agent tools (§4)
│   ├── sbpa-service.cds / .js      # SBPA callback (§4.3)
│   ├── admin-service.cds / .js     # reset_demo_data
│   └── lib/
│       ├── dates.js                # today(), offsetToDate(n) — per request
│       ├── price-lock.js           # acquire / release lock (atomic, §3.5)
│       └── sbpa-client.js          # start process instance; SBPA_MODE=mock|live
├── test/tools.test.js              # cds.test acceptance tests (§7)
├── scripts/smoke.sh
└── openapi/optisell-tools.openapi.json
```

## 3. Data model (`db/schema.cds`, namespace `optisell`)

### 3.1 Stock and reference data (unchanged from v1)

| Entity | Key | Fields |
|---|---|---|
| `StockBatches` | `batch` | `store_id`, `sku`, `name`, `category`, `qty: Double`, `expiry_offset: Integer`, `unit_cost: Double` |
| `SalesDaily` | `sku`, `day_offset` | `store_id`, `units: Double` (−14 … −1) |
| `Forecast` | `sku` | `store_id`, `daily_units: Double` |
| `Events` | `name` | `store_id`, `day_offset: Integer`, `impact_pct: Double`, `categories: String` (comma-separated) |
| `MarkdownPolicies` | `category` | `floor_margin_pct`, `min_markdown_pct`, `max_markdown_pct`, `step_pct`, `elasticity` |
| `CompetitorPrices` | `sku`, `name` | `price: Double`, `observed_offset: Integer` |
| `Counters` | `name` | `value: Integer` (proposal sequence, starts at 3) |

### 3.2 `MaterialPrices` — the price table, also the approval lock

One row per store + sku + batch. **This is the only place a selling price is read from or written to.**

| Field | Type | Meaning |
|---|---|---|
| `store_id`, `sku`, `batch` | String (key) | |
| `regular_price` | Double | price before any markdown (never changes) |
| `current_price` | Double | selling price now (changed only by an approved SBPA callback) |
| `currency` | String | `INR` |
| `price_valid_from` | Date | when `current_price` took effect |
| `approval_status` | String | `NONE` · `TRIGGERING` · `PENDING` · `APPLIED` · `REJECTED` · `FAILED` · `EXPIRED` |
| `active_proposal_id` | String | the open request (null when no approval is open) |
| `sbpa_instance_id` | String | SBPA process instance ID of the open request (null when none open) |
| `proposed_price` | Double | the "new amount" waiting for approval (null when none open) |
| `approval_requested_at` | Timestamp | |
| `approval_decided_at` | Timestamp | last decision time |
| `last_decided_by` | String | |

**Invariants (enforce in code and test them):**
- **Locked** ⇔ `approval_status` ∈ {`TRIGGERING`, `PENDING`}.
  While locked: `active_proposal_id`, `proposed_price` are NOT null;
  `sbpa_instance_id` is NOT null once status is `PENDING`.
- **Free** ⇔ any other status. While free: `active_proposal_id`, `sbpa_instance_id`,
  `proposed_price` are all null. `approval_status` keeps the **last** outcome
  (`APPLIED`, `REJECTED`, …) for display.
- A new approval for a row is allowed only when the row is **free**.

### 3.3 `PriceApprovalRequests` — one row per request (full history / audit)

| Field | Type | Meaning |
|---|---|---|
| `proposal_id` | String (key) | `P-0003`, `P-0004`, … |
| `store_id`, `sku`, `batch` | String | |
| `old_price` | Double | `regular_price` at request time |
| `new_price` | Double | proposed price |
| `discount_pct`, `margin_pct`, `at_risk_qty` | Double | |
| `margin_breach` | Boolean | |
| `reason` | String | |
| `approver_role` | String | `category_manager` if breach else `store_manager` |
| `status` | String | `pending` · `applied` · `rejected` · `failed` · `expired` |
| `sbpa_instance_id` | String (unique, nullable until started) | |
| `sbpa_definition_id` | String | |
| `requested_by` | String | |
| `created` | Date | |
| `requested_at`, `decided_at`, `applied_at` | Timestamp | |
| `decided_by`, `decision_comment` | String | |
| `error_message` | String | e.g. SBPA start failure |

### 3.4 `Outcomes`

| Entity | Key | Fields |
|---|---|---|
| `Outcomes` | `proposal_id` | `units_sold`, `units_wasted`, `recovered_value`, `recorded: Date` |

### 3.5 Lock acquisition must be atomic

Two requests for the same batch must never both start an SBPA process. Acquire the lock with a
single conditional update and check the affected-row count:

```js
const n = await UPDATE(MaterialPrices)
  .set({ approval_status: 'TRIGGERING', active_proposal_id: pid, proposed_price: newPrice,
         sbpa_instance_id: null, approval_requested_at: now })
  .where({ store_id, sku, batch, approval_status: { 'not in': ['TRIGGERING', 'PENDING'] } });
if (n === 0) → 409 "Batch <batch> already has an approval in progress (<active_proposal_id>, <sbpa_instance_id>)"
```

## 4. Endpoints

Error convention: HTTP 404 / 409 / 400 with CAP's default body `{"error": {"code", "message"}}`.

### 4.1 Read tools (`/tools`, read-only)

**Tool 1 `get_store_stock`** — req `store_id`, opt `horizon_days` (default 7).
Batches with `expiry <= today + horizon_days`; `price` = `MaterialPrices.current_price`.
Extra fields (allowed): `approval_status`, `active_proposal_id`.
```json
{"store_id": "S101", "currency": "INR",
 "items": [{"sku": "MLK-1L", "name": "Toned milk 1L", "category": "dairy", "batch": "B2301",
            "qty": 120, "expiry": "2026-11-22", "unit_cost": 40.0, "price": 68.0,
            "approval_status": "NONE", "active_proposal_id": null}]}
```

**Tool 2 `get_sales_history`** — req `store_id`, opt `days` (14), opt `sku`.
Fields **`from_date` / `to_date`**; `from_date = today - days + 1`, `to_date = today`.
```json
{"store_id": "S101", "from_date": "2026-11-06", "to_date": "2026-11-19",
 "sales": [{"sku": "MLK-1L", "date": "2026-11-18", "units": 15}]}
```

**Tool 3 `get_demand_signals`** — req `store_id`, opt `horizon_days` (7).
```json
{"forecast": [{"sku": "MLK-1L", "daily_units": 15}],
 "events": [{"name": "Heavy rain", "date": "2026-11-20", "impact_pct": -20,
             "categories": ["dairy", "bakery", "produce"]}]}
```

**Tool 4 `get_markdown_policy`** — req `category`; unknown → 404.
```json
{"category": "dairy", "floor_margin_pct": 15, "min_markdown_pct": 10,
 "max_markdown_pct": 50, "step_pct": 10, "elasticity": -2.2}
```

**Tool 5 `get_competitor_prices`** — req `store_id`, `sku`; no data → empty list.
```json
{"sku": "BAN-12", "competitor_prices": [{"name": "FreshMart", "price": 48.0, "observed": "2026-11-19"}]}
```

**Proposal object** (Tools 6, 7, 8) — these 14 fields required, plus extras:
```json
{"proposal_id": "P-0003", "store_id": "S101", "sku": "MLK-1L", "batch": "B2301",
 "old_price": 68.0, "new_price": 47.6, "discount_pct": 30, "margin_pct": 16.0,
 "margin_breach": false, "at_risk_qty": 63, "reason": "Expires in 3 days, 63 units at risk",
 "status": "pending", "approver_role": "store_manager", "created": "2026-11-19",
 "sbpa_instance_id": "8f2c…", "decided_by": null, "decided_at": null}
```

**Tool 7 `get_proposals`** — req `store_id`, opt `status` → `{"proposals": [ <proposal object> ]}`

**Tool 8 `get_approval_status`** (new) — req `proposal_id`; 404 if unknown → `<proposal object>`

**Tool 10 `record_outcome`** — req `proposal_id`, `units_sold`, `units_wasted`;
404 if unknown; 409 unless status `applied`. `recovered_value = units_sold * new_price`.
```json
{"proposal_id": "P-0003", "recovered_value": 5236.0, "recorded": "2026-11-19"}
```

**Tool 11 `get_markdown_kpis`** — req `store_id`.
`approved` = count of `applied`; `waste_avoided_value` = Σ over outcomes of
`max(0, at_risk_qty - units_wasted) * unit_cost`.
```json
{"proposals_created": 2, "approved": 1, "rejected": 1, "applied": 1,
 "recovered_value": 312.0, "waste_avoided_value": 234.0}
```

### 4.2 Tool 6 `create_proposal` — starts the SBPA approval (write)

Request (all required): `store_id`, `sku`, `batch`, `old_price`, `new_price`, `discount_pct`,
`margin_pct`, `margin_breach`, `at_risk_qty`, `reason`; optional `requested_by`.

Steps (in this order):
1. 404 if sku/batch unknown. 400 if `new_price >= regular_price` or `new_price <= 0`.
2. Allocate `proposal_id`, insert `PriceApprovalRequests` row with status `pending`,
   `old_price = regular_price` (ignore a different `old_price` in the request).
3. **Acquire the lock** (§3.5). If it fails → delete the row from step 2 and return 409.
4. Start SBPA (§6) with context: `proposal_id, store_id, sku, batch, old_price, new_price,
   discount_pct, margin_pct, margin_breach, approver_role, reason, at_risk_qty`.
5. Success → store `sbpa_instance_id` on **both** tables; `MaterialPrices.approval_status = PENDING`.
6. Failure → request status `failed` with `error_message`; **release the lock**
   (`approval_status = FAILED`, clear `active_proposal_id`, `sbpa_instance_id`, `proposed_price`);
   return 502 `{"error": {"code": "SBPA_START_FAILED", "message": …}}`.

Response: the proposal object (status `pending`, `sbpa_instance_id` set).

### 4.3 SBPA callback — `POST /sbpa/complete_approval` (only SBPA calls this)

Request: `sbpa_instance_id` (req), `decision` (`approve` | `reject`, req), `decided_by` (req),
`comment` (opt). **No price in the request — the price always comes from the stored request.**

Rules:
1. Find the request by `sbpa_instance_id`; 404 if none.
2. **Idempotent**: if the request is already `applied` / `rejected`, return the current proposal
   object with HTTP 200 and change nothing (SBPA may retry).
3. The `MaterialPrices` row must be `PENDING` with the **same** `sbpa_instance_id`;
   otherwise 409 (and log it).
4. `approve` → in one transaction:
   `current_price = request.new_price`, `price_valid_from = today`,
   `approval_status = APPLIED`, clear `active_proposal_id`, `sbpa_instance_id`, `proposed_price`,
   set `approval_decided_at`, `last_decided_by`;
   request `status = applied`, `decided_by`, `decided_at`, `applied_at`, `decision_comment`.
5. `reject` → price unchanged; `approval_status = REJECTED`, clear the three lock fields;
   request `status = rejected`, decision fields set.
6. Response: the proposal object.

### 4.4 Expiry of open approvals — `POST /admin/expire_stale_approvals`

For locked rows whose batch has expired (expiry < today) or whose request is older than
`APPROVAL_TIMEOUT_HOURS` (env, default 24): request `status = expired`,
`approval_status = EXPIRED`, clear the lock fields. (SBPA cancellation is optional for the POC.)
Response: `{"expired": ["P-0005", …]}`.

### 4.5 Removed from `/tools`

`record_decision` and `update_sales_price` are **not** agent tools any more. Only SBPA decides,
and only `/sbpa/complete_approval` changes a price. Do not expose any endpoint that sets
`current_price` from a client-supplied value.

### 4.6 Admin

`POST /admin/reset_demo_data` — reload §5 seed (prices back to regular, all `MaterialPrices`
free with `approval_status = NONE`, requests back to P-0001/P-0002, counter 3).

## 5. Seed data (`db/data/*.csv`)

**Stock and prices (store S101)** — `MaterialPrices`: `regular_price = current_price` = price below,
`approval_status = NONE`, lock fields null.

| sku | name | category | batch | qty | expiry_offset | daily rate | price | unit_cost |
|---|---|---|---|---|---|---|---|---|
| MLK-1L | Toned milk 1L | dairy | B2301 | 120 | 3 | 15 | 68 | 40 |
| YGT-GRK | Greek yogurt 100g | dairy | B2302 | 60 | 2 | 12 | 60 | 50 |
| CRS-2PC | Croissant 2 pc | bakery | B2303 | 30 | 1 | 6 | 90 | 45 |
| CRD-400 | Curd 400g | dairy | B2304 | 30 | 0 | 25 | 45 | 34 |
| CRD-400 | Curd 400g | dairy | B2305 | 80 | 4 | 25 | 45 | 34 |
| BAN-12 | Bananas 12 pc | produce | B2306 | 50 | 3 | 18 | 60 | 40 |
| STR-200 | Strawberries 200g | produce | B2307 | 30 | 2 | 4 | 150 | 100 |
| BRD-WW | Whole wheat bread 400g | bakery | B2308 | 40 | 2 | 20 | 50 | 35 |
| SPN-BN | Spinach bunch | produce | B2309 | 40 | 1 | 15 | 30 | 18 |
| PNR-200 | Paneer 200g | dairy | B2310 | 45 | 3 | 10 | 95 | 70 |
| TOM-1KG | Tomato 1 kg | produce | B2311 | 80 | 5 | 30 | 40 | 30 |

Exception: SPN-BN / B2309 `current_price = 24`, `approval_status = APPLIED` (from P-0001).

**Forecast** = daily rate per SKU. **Sales history**: 14 rows per SKU (`day_offset` −14 … −1),
`units = round(daily_rate * m)`, `m = [1.0, 1.1, 0.9, 1.0, 1.05, 0.95, 1.0, 1.1, 0.9, 1.0, 1.0, 1.05, 0.95, 1.0]`,
adjust the −1 row so the total is exactly `daily_rate * 14`.

**Event**: Heavy rain, `day_offset` 1, `impact_pct` −20, `dairy,bakery,produce`.

**Policy**: dairy 15/10/50/10/−2.2 · bakery 15/10/50/10/−2.8 · produce 15/10/50/10/−2.0
(floor/min/max/step/elasticity).

**Competitors** (`observed_offset` 0): BAN-12 FreshMart 48.0 · STR-200 QuickCart 129.0 ·
MLK-1L DailyBasket 66.0 · CRS-2PC FreshMart 80.0

**Requests**: P-0001 SPN-BN/B2309 30→24, 20%, margin 25.0, no breach, at_risk 13, `applied`,
store_manager, `sbpa_instance_id = "seed-0001"`, outcome sold 13 wasted 0 recovered 312.0 ·
P-0002 BRD-WW/B2308 50→40, 20%, margin 12.5, breach true, at_risk 0, "Promotional markdown",
`rejected`, category_manager, `sbpa_instance_id = "seed-0002"`. Both `created` = today − 2. Counter = 3.

## 6. SBPA integration

- `srv/lib/sbpa-client.js` → `startApproval(context)` returns `{ instanceId }`
- `SBPA_MODE=mock` (default locally and in tests): returns `mock-<uuid>`; no network call
- `SBPA_MODE=live`: POST to the SBPA process **API trigger** (use the URL and payload shown for the
  trigger in SBPA; typically `POST {SBPA_API_URL}/workflow/rest/v1/workflow-instances` with
  `{"definitionId": SBPA_DEFINITION_ID, "context": {...}}`), OAuth2 client credentials with
  `SBPA_TOKEN_URL`, `SBPA_CLIENT_ID`, `SBPA_CLIENT_SECRET`; instance ID = response `id`
- SBPA process (built in SBPA, not in this repo): approval form showing the context →
  route by `approver_role` (store manager / category manager group) → final **action** that calls
  `POST /sbpa/complete_approval` with `sbpa_instance_id` (process instance ID), `decision`,
  `decided_by`, `comment` — via a BTP destination to this app with client credentials
- Auth: `/sbpa` requires scope `$XSAPPNAME.SbpaCallback`; `/tools` requires `$XSAPPNAME.Tools`;
  give the agent's client only `Tools` and SBPA's client only `SbpaCallback`
  (`xs-security.json`: two scopes, `authorities` on the clients/service keys accordingly)

## 7. Acceptance tests (`test/tools.test.js`, `SBPA_MODE=mock`) — all must pass

1. `get_store_stock` returns 11 items; MLK-1L price 68, `approval_status` NONE
2. `get_sales_history` MLK-1L sums to 210; keys `from_date` / `to_date`
3. `create_proposal` MLK-1L/B2301 47.6 → P-0003 `pending`, `sbpa_instance_id` starts with `mock-`;
   `MaterialPrices` row: PENDING, `proposed_price` 47.6, `active_proposal_id` P-0003
4. Second `create_proposal` for B2301 while PENDING → 409, no new request row, counter unchanged
5. Concurrency: two parallel `create_proposal` for B2303 → exactly one 200, one 409
6. `get_store_stock` while pending → MLK-1L price still 68
7. Callback `approve` with P-0003's instance ID → request `applied`; price 47.6;
   lock fields null; `approval_status` APPLIED
8. Same callback again → 200, nothing changes (idempotent)
9. Callback with unknown instance ID → 404
10. New `create_proposal` for B2301 after APPLIED → allowed (row is free)
11. YGT-GRK proposal (breach) → `category_manager`; callback `reject` → price stays 60,
    status REJECTED, lock cleared
12. SBPA start failure (mock throws) → 502, request `failed`, row free with status FAILED
13. `expire_stale_approvals` with a locked row on an expired batch → `expired`, lock cleared
14. `record_outcome` P-0003 sold 110 wasted 10 → 5236.0; KPIs → recovered 5548.0, waste avoided 2354.0
15. `/tools` rejects a token without `Tools` scope; `/sbpa` rejects the agent's token
16. All responses are plain JSON (no `value` / `@odata.context`)

## 8. OpenAPI for the Joule Studio MCP server

`cds compile srv/tools-service.cds --to openapi` → set `servers` to the deployed URL →
10 tools: `get_store_stock`, `get_sales_history`, `get_demand_signals`, `get_markdown_policy`,
`get_competitor_prices`, `create_proposal`, `get_proposals`, `get_approval_status`,
`record_outcome`, `get_markdown_kpis` — read-only: all `get_*`; writes: `create_proposal`,
`record_outcome`. Do **not** include `/sbpa` or `/admin` in this OpenAPI file.

## 9. Agent changes to make in Joule Studio afterwards (not part of this repo)

- Remove the in-chat approval interrupt, `record_decision` and `update_sales_price` from the agent
- After `create_proposal`: "Sent for approval in SBPA (P-0003, approver: store manager). The price
  changes only after approval." New command: "status of P-0003" → `get_approval_status`
- Before recommending or proposing: if the batch's `approval_status` is PENDING (or
  TRIGGERING), say "Batch <batch> has approval <id> in progress" — no new recommendation
- Keep R12 (proposal values only from the recommendation) and the rules module unchanged
