SELECT count(*) AS unresolved_reserved_count
FROM sandbox_execution_records reservation
WHERE json_extract(reservation.plan_json,'$.backendRef')='srt'
  AND reservation.preparation_state='reserved'
  AND reservation.started_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM sandbox_reservation_release_receipts released
    WHERE released.job_id=reservation.job_id
      AND json_extract(released.verification_json,'$.identity.jobId')=reservation.job_id
      AND json_extract(released.verification_json,'$.stopRequestedAt')=reservation.reservation_stopped_at
  )
  AND NOT EXISTS (
    SELECT 1 FROM sandbox_release_receipts released
    WHERE released.job_id=reservation.job_id
      AND json_extract(released.verification_json,'$.identity.jobId')=reservation.job_id
  );
