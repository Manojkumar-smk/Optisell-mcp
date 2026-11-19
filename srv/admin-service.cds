/** Demo administration. */
@protocol: 'rest'
@path: '/admin'
@requires: 'Tools'
service AdminService {
  /** Reload the seed data (prices back to regular, all rows free, requests P-0001/P-0002, counter 3). */
  action reset_demo_data() returns {
    reset           : Boolean;
    next_proposal   : String;
  };

  /** Expire open approvals whose batch has expired or that are older than APPROVAL_TIMEOUT_HOURS (default 24). */
  action expire_stale_approvals() returns {
    expired : many String;
  };
}
