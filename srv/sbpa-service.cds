using { optisell.api.Proposal } from './types';

/** Called ONLY by SAP Build Process Automation (approval callback). */
@protocol: 'rest'
@path: '/sbpa'
@requires: 'SbpaCallback'
service SbpaService {
  /** Final action of the SBPA process. Idempotent for already decided requests. Price comes from the stored request. */
  action complete_approval(
    sbpa_instance_id : String not null,
    /** approve | reject */
    decision         : String not null,
    decided_by       : String not null,
    comment          : String
  ) returns Proposal;
}
