import assert from "node:assert/strict";

const approvedPlan = Object.freeze({
  decisionRef: "G90",
  routeKey: "coding",
  grantId: "directory:himawari-prod-workspace-20261015",
  canonicalPath: "/var/lib/himawari/workspace",
  subdirectories: Object.freeze(["files", "repos"]),
});

export function validateWorkspacePlan(plan) {
  assert.deepEqual(plan, approvedPlan, "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED");
  return structuredClone(plan);
}

export function verifyExistingGrant(live, frozen, plan) {
  validateWorkspacePlan(plan);
  assert(Array.isArray(live) && Array.isArray(frozen), "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_REQUIRED");
  assert.equal(frozen.length, 1, "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_SET_CHANGED");
  const expected = frozen[0];
  assert(expected.routeKey === plan.routeKey && expected.grantId === plan.grantId && expected.displayPath === plan.canonicalPath, "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_CHANGED");
  assert.deepEqual(live, frozen, "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_CHANGED");
  assert(expected.revokedAt === null && Date.parse(expected.expiresAt) > Date.now(), "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_UNUSABLE");
  for (const key of ["readAllowed", "hostMatchesRoute", "rootMatchesSnapshot", "currentlyUsable"]) assert.equal(expected[key], true, "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_UNUSABLE");
  return expected;
}

export function verifyWorkspaceIdentity(live, frozen, plan) {
  validateWorkspacePlan(plan);
  assert(frozen && typeof frozen === "object" && frozen.path === plan.canonicalPath, "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_IDENTITY_REQUIRED");
  assert.deepEqual(frozen.subdirectories.map((child) => child.name), plan.subdirectories, "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_SUBDIRECTORIES_CHANGED");
  assert(frozen.uid === __PKT_SERVICE_UID__ && frozen.gid === __PKT_SERVICE_GID__ && frozen.mode === "0700", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_OWNER_OR_MODE_CHANGED");
  assert.deepEqual(live, frozen, "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_IDENTITY_CHANGED");
  return live;
}
