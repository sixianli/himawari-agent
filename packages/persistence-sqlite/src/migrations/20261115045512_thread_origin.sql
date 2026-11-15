ALTER TABLE threads ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner';

UPDATE threads SET origin = 'think'
WHERE id GLOB 'thread:think:*'
  AND EXISTS (
    SELECT 1 FROM thread_command_receipts AS receipt
    JOIN think_inbox AS entry
      ON entry.owner_id = receipt.owner_id
      AND entry.agent_id = receipt.agent_id
      AND receipt.idempotency_key = 'think-thread:' || entry.id
    WHERE receipt.thread_id = threads.id
      AND receipt.owner_id = threads.owner_id
      AND receipt.agent_id = threads.agent_id
      AND receipt.command_type = 'thread.create'
  );
