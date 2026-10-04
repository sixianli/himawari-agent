import {
  SANDBOX_PREPARATION_LAUNCH_PROTOCOL,
  SANDBOX_PREPARATION_PROTOCOL,
} from "@himawari-agent/execution-contracts";

export const SANDBOX_RESERVATION_NEVER_STARTED_SQL = `(
  json_extract(reservation.verification_json,'$.basis')='host_never_started'
  OR (json_extract(reservation.verification_json,'$.basis')='preparation_not_authorized'
    AND json_extract(result.plan_json,'$.backendRef')='srt'
    AND json_extract(result.plan_json,'$.preparationProtocol') IN ('${SANDBOX_PREPARATION_PROTOCOL}','${SANDBOX_PREPARATION_LAUNCH_PROTOCOL}'))
  OR (json_extract(reservation.verification_json,'$.basis')='preparation_launch_blocked'
    AND json_extract(result.plan_json,'$.backendRef')='srt'
    AND json_extract(result.plan_json,'$.preparationProtocol')='${SANDBOX_PREPARATION_LAUNCH_PROTOCOL}')
)`;
