namespace optisell;

// ---------------------------------------------------------------------------
// 3.1 Stock and reference data — all dates are stored as day offsets relative
// to "today" and resolved per request (see srv/lib/dates.js).
// ---------------------------------------------------------------------------

entity StockBatches {
  key batch         : String(20);
      store_id      : String(10);
      sku           : String(20);
      name          : String(100);
      category      : String(30);
      qty           : Double;
      expiry_offset : Integer;
      unit_cost     : Double;
}

entity SalesDaily {
  key sku        : String(20);
  key day_offset : Integer; // -14 … -1
      store_id   : String(10);
      units      : Double;
}

entity Forecast {
  key sku         : String(20);
      store_id    : String(10);
      daily_units : Double;
}

entity Events {
  key name       : String(100);
      store_id   : String(10);
      day_offset : Integer;
      impact_pct : Double;
      categories : String(200); // comma-separated
}

entity MarkdownPolicies {
  key category         : String(30);
      floor_margin_pct : Double;
      min_markdown_pct : Double;
      max_markdown_pct : Double;
      step_pct         : Double;
      elasticity       : Double;
}

entity CompetitorPrices {
  key sku             : String(20);
  key name            : String(100);
      price           : Double;
      observed_offset : Integer;
}

entity Counters {
  key name  : String(30);
      value : Integer;
}

// ---------------------------------------------------------------------------
// 3.2 MaterialPrices — the only source of selling prices; also the approval lock.
//   Locked ⇔ approval_status ∈ {TRIGGERING, PENDING}
// ---------------------------------------------------------------------------

entity MaterialPrices {
  key store_id              : String(10);
  key sku                   : String(20);
  key batch                 : String(20);
      regular_price         : Double;
      current_price         : Double;
      currency              : String(3);
      price_valid_from      : Date;
      approval_status       : String(12) default 'NONE'; // NONE|TRIGGERING|PENDING|APPLIED|REJECTED|FAILED|EXPIRED
      active_proposal_id    : String(10);
      sbpa_instance_id      : String(100);
      proposed_price        : Double;
      approval_requested_at : Timestamp;
      approval_decided_at   : Timestamp;
      last_decided_by       : String(255);
}

// ---------------------------------------------------------------------------
// 3.3 PriceApprovalRequests — one row per request (history / audit)
// ---------------------------------------------------------------------------

@assert.unique: { sbpa_instance: [sbpa_instance_id] }
entity PriceApprovalRequests {
  key proposal_id        : String(10);
      store_id           : String(10);
      sku                : String(20);
      batch              : String(20);
      old_price          : Double;
      new_price          : Double;
      discount_pct       : Double;
      margin_pct         : Double;
      at_risk_qty        : Double;
      margin_breach      : Boolean;
      reason             : String(500);
      approver_role      : String(30);  // store_manager | category_manager
      status             : String(10);  // pending|applied|rejected|failed|expired
      sbpa_instance_id   : String(100); // unique, null until started
      sbpa_definition_id : String(255);
      requested_by       : String(255);
      created            : Date;
      requested_at       : Timestamp;
      decided_at         : Timestamp;
      applied_at         : Timestamp;
      decided_by         : String(255);
      decision_comment   : String(1000);
      error_message      : String(1000);
}

// ---------------------------------------------------------------------------
// 3.4 Outcomes
// ---------------------------------------------------------------------------

entity Outcomes {
  key proposal_id     : String(10);
      units_sold      : Double;
      units_wasted    : Double;
      recovered_value : Double;
      recorded        : Date;
}
