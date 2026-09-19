-- Private network scopes use sandbox-scope.v2 and have no shared workspace claim.
-- Block older writers before they encounter this versioned execution contract.
-- Existing directory scopes and execution records are unchanged.
SELECT 1;
