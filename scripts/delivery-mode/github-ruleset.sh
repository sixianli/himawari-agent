#!/bin/sh
set -eu

repository=sixianli/himawari-agent
ruleset_id=22256403

case "${1:-}" in
  fast)
    rules='[
      {"type": "deletion"},
      {"type": "non_fast_forward"},
      {"type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {"context": "ci/required", "integration_id": 15368},
          {"context": "apple/required", "integration_id": 15368}
        ]
      }}
    ]'
    ;;
  full)
    rules='[
      {"type": "deletion"},
      {"type": "non_fast_forward"},
      {"type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "required_reviewers": [],
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": true,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }},
      {"type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {"context": "ci/required", "integration_id": 15368},
          {"context": "apple/required", "integration_id": 15368}
        ]
      }}
    ]'
    ;;
  *)
    echo "usage: $0 fast|full" >&2
    exit 2
    ;;
esac

printf '{"rules": %s}\n' "$rules" |
  gh api --method PUT "repos/$repository/rulesets/$ruleset_id" --input - \
    --jq '"\(.name) \(.enforcement): " + ([.rules[].type] | join(", "))'
