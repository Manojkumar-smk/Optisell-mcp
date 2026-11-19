namespace optisell.api;

/** Proposal object — returned by create_proposal, get_proposals, get_approval_status and the SBPA callback. */
type Proposal {
  proposal_id        : String;
  store_id           : String;
  sku                : String;
  batch              : String;
  old_price          : Double;
  new_price          : Double;
  discount_pct       : Double;
  margin_pct         : Double;
  margin_breach      : Boolean;
  at_risk_qty        : Double;
  reason             : String;
  /** pending | applied | rejected | failed | expired */
  status             : String;
  /** store_manager | category_manager */
  approver_role      : String;
  /** YYYY-MM-DD */
  created            : Date;
  sbpa_instance_id   : String;
  sbpa_definition_id : String;
  requested_by       : String;
  /** YYYY-MM-DDTHH:MM:SSZ */
  requested_at       : DateTime;
  decided_by         : String;
  /** YYYY-MM-DDTHH:MM:SSZ */
  decided_at         : DateTime;
  /** YYYY-MM-DDTHH:MM:SSZ */
  applied_at         : DateTime;
  decision_comment   : String;
  error_message      : String;
}
