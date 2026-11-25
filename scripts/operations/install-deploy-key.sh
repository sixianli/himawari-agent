#!/bin/bash
set -euo pipefail
umask 077
repo="${HIMAWARI_REPO:-sixianli/himawari-agent}"
environment="${HIMAWARI_DEPLOY_ENVIRONMENT:-production}"
host="${HIMAWARI_PACKET_HOST:-}"
[[ -n "$host" ]] || { echo "DEPLOY_KEY_REFUSED: set HIMAWARI_PACKET_HOST to the production machine address" >&2; exit 64; }
[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$ ]] || { echo "DEPLOY_KEY_REFUSED: unsafe host $host" >&2; exit 64; }
command -v gh >/dev/null || { echo "DEPLOY_KEY_REFUSED: gh (GitHub command line) is not installed or not signed in; run gh auth login" >&2; exit 69; }
gh auth status >/dev/null 2>&1 || { echo "DEPLOY_KEY_REFUSED: gh is not signed in; run gh auth login" >&2; exit 69; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
ssh-keygen -q -t ed25519 -N '' -C "himawari-github-deploy" -f "$work/key"

host_key="$(ssh-keygen -F "$host" 2>/dev/null | awk '$1 !~ /^#/ && $2 == "ssh-ed25519" {print $2 " " $3; exit}')"
if [[ -z "$host_key" ]]; then
  echo "DEPLOY_KEY_REFUSED: $host has no ssh-ed25519 entry in this machine's known_hosts; connect to it once with ssh first so the fingerprint is one you have verified" >&2
  exit 65
fi

public="$(cat "$work/key.pub")"
line="restrict $public"
for account in root himawari-build; do
  home="$(ssh -o BatchMode=yes "root@$host" "getent passwd $account | cut -d: -f6")"
  [[ "$home" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "DEPLOY_KEY_REFUSED: cannot read the home directory of $account" >&2; exit 66; }
  ssh -o BatchMode=yes "root@$host" "install -d -m 700 -o $account '$home/.ssh' && touch '$home/.ssh/authorized_keys' && chown $account '$home/.ssh/authorized_keys' && chmod 600 '$home/.ssh/authorized_keys' && (grep -qF -- '$public' '$home/.ssh/authorized_keys' || printf '%s\n' '$line' >> '$home/.ssh/authorized_keys')"
done

gh api --method PUT "repos/$repo/environments/$environment" --input - >/dev/null <<JSON
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
gh api --method POST "repos/$repo/environments/$environment/deployment-branch-policies" -f name=main -f type=branch >/dev/null 2>&1 || true
gh secret set PROD_SSH_KEY --repo "$repo" --env "$environment" < "$work/key"
gh variable set PROD_HOST --repo "$repo" --env "$environment" --body "$host"
gh variable set PROD_HOST_KEY --repo "$repo" --env "$environment" --body "$host_key"
echo "DEPLOY_KEY_INSTALLED fingerprint=$(ssh-keygen -lf "$work/key.pub" | awk '{print $2}') environment=$environment host=$host"
