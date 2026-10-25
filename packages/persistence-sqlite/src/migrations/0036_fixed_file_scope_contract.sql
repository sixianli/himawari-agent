-- Writer version barrier for file identity/path-slot claims and the protected
-- sandbox-file-target.v1 snapshot used by pi-coding-tool contract version 2.
-- Existing JSON records remain intact; old readers must not strip the new
-- scope/claim fields and continue under a different coordination contract.
SELECT 1;
