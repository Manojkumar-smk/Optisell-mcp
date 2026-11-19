using { optisell.api.Proposal } from './types';

/**
 * OptiSell agent tools. Every tool is `POST /tools/<tool_name>` with a JSON body of named parameters.
 * Read-only tools: all get_*. Write tools: create_proposal, record_outcome.
 * Prices only change after an approval in SAP Build Process Automation.
 */
@protocol: 'rest'
@path: '/tools'
@requires: 'Tools'
service ToolsService {

  type StockItem {
    sku                : String;
    name               : String;
    category           : String;
    batch              : String;
    qty                : Double;
    /** YYYY-MM-DD */
    expiry             : Date;
    unit_cost          : Double;
    /** current selling price (MaterialPrices.current_price) */
    price              : Double;
    /** NONE | TRIGGERING | PENDING | APPLIED | REJECTED | FAILED | EXPIRED */
    approval_status    : String;
    active_proposal_id : String;
  }

  /** Read-only. Batches of a store expiring within horizon_days (default 7), with current price and approval state. */
  action get_store_stock(store_id : String not null, horizon_days : Integer) returns {
    store_id : String;
    currency : String;
    items    : many StockItem;
  };

  /** Read-only. Daily unit sales for the last `days` days (default 14), optionally for one sku. */
  action get_sales_history(store_id : String not null, days : Integer, sku : String) returns {
    store_id  : String;
    from_date : Date;
    to_date   : Date;
    sales     : many {
      sku   : String;
      date  : Date;
      units : Double;
    };
  };

  /** Read-only. Demand forecast per sku and events within horizon_days (default 7). */
  action get_demand_signals(store_id : String not null, horizon_days : Integer) returns {
    forecast : many {
      sku         : String;
      daily_units : Double;
    };
    events   : many {
      name       : String;
      date       : Date;
      impact_pct : Double;
      categories : many String;
    };
  };

  /** Read-only. Markdown policy for a category; 404 if unknown. */
  action get_markdown_policy(category : String not null) returns {
    category         : String;
    floor_margin_pct : Double;
    min_markdown_pct : Double;
    max_markdown_pct : Double;
    step_pct         : Double;
    elasticity       : Double;
  };

  /** Read-only. Competitor prices for a sku (empty list if none). */
  action get_competitor_prices(store_id : String not null, sku : String not null) returns {
    sku               : String;
    competitor_prices : many {
      name     : String;
      price    : Double;
      observed : Date;
    };
  };

  /**
   * Write. Creates a price-change request and starts the SBPA approval process.
   * The price is NOT changed here — only after SBPA approves. 409 if the batch already has an approval in progress.
   */
  action create_proposal(
    store_id      : String not null,
    sku           : String not null,
    batch         : String not null,
    old_price     : Double not null,
    new_price     : Double not null,
    discount_pct  : Double not null,
    margin_pct    : Double not null,
    margin_breach : Boolean not null,
    at_risk_qty   : Double not null,
    reason        : String not null,
    requested_by  : String
  ) returns Proposal;

  /** Read-only. Proposals of a store, optionally filtered by status (pending|applied|rejected|failed|expired). */
  action get_proposals(store_id : String not null, status : String) returns {
    proposals : many Proposal;
  };

  /** Read-only. Current status of one proposal; 404 if unknown. */
  action get_approval_status(proposal_id : String not null) returns Proposal;

  /** Write. Records the sales outcome of an applied proposal; 409 unless status is applied. */
  action record_outcome(proposal_id : String not null, units_sold : Double not null, units_wasted : Double not null) returns {
    proposal_id     : String;
    recovered_value : Double;
    /** YYYY-MM-DD */
    recorded        : Date;
  };

  /** Read-only. Markdown KPIs for a store. */
  action get_markdown_kpis(store_id : String not null) returns {
    proposals_created   : Integer;
    approved            : Integer;
    rejected            : Integer;
    applied             : Integer;
    recovered_value     : Double;
    waste_avoided_value : Double;
  };
}
