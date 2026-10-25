/** Correlated with sandbox_execution_records r, bound with @recoveryNow.
 * This predicate only discovers a stop obligation. It never grants execution,
 * refunds a consumed use, or supplies proof that a resource has stopped. */
export const SANDBOX_AUTHORITY_WITHDRAWN_SQL = `NOT EXISTS (
  SELECT 1 FROM capability_handles h
  JOIN capability_declarations c ON c.id=h.capability_id
  WHERE h.id=json_extract(r.plan_json,'$.handleRef')
    AND h.run_id=r.run_id AND c.owner_id=r.owner_id AND c.agent_id=r.agent_id
    AND h.revoked_at IS NULL AND h.expires_at>@recoveryNow
    AND json_extract(h.record_json,'$.revokedAt') IS NULL
    AND json_extract(h.record_json,'$.workerEndedAt') IS NULL
    AND c.status IN ('active','update_proposed','update_approved')
    AND (json_extract(h.record_json,'$.authorization.type')!='grant' OR EXISTS (
      SELECT 1 FROM grants g
      WHERE g.id=json_extract(h.record_json,'$.authorization.ref')
        AND g.owner_id=r.owner_id AND g.agent_id=r.agent_id
        AND json_extract(g.record_json,'$.revokedAt') IS NULL
        AND json_extract(g.record_json,'$.validFrom')<=@recoveryNow
        AND json_extract(g.record_json,'$.expiresAt')>@recoveryNow
    ))
)`;
