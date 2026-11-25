#!/bin/bash
set -euo pipefail
umask 077
here="$(cd "$(dirname "$0")" && pwd)"
repo="${HIMAWARI_REPO:-sixianli/himawari-agent}"
environment="${HIMAWARI_DEPLOY_ENVIRONMENT:-production}"
host="${HIMAWARI_PACKET_HOST:-}"
account=himawari-deploy
library=/usr/local/lib/himawari-deploy
refuse() { echo "DEPLOY_KEY_REFUSED: $1" >&2; exit "${2:-64}"; }
[[ -n "$host" ]] || refuse "set HIMAWARI_PACKET_HOST to the production machine address"
[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$ ]] || refuse "unsafe host $host"
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || refuse "gh (GitHub command line) is missing or not signed in; run gh auth login" 69

host_key="$(ssh-keygen -F "$host" 2>/dev/null | awk '$1 !~ /^#/ && $2 == "ssh-ed25519" {print $2 " " $3; exit}')"
[[ -n "$host_key" ]] || refuse "$host has no ssh-ed25519 entry in this machine's known_hosts; connect to it once with ssh first so the fingerprint is one you have verified" 65

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
ssh-keygen -q -t ed25519 -N '' -C "himawari-github-deploy" -f "$work/key"
public="$(cut -d' ' -f1,2 "$work/key.pub")"

tar -C "$here/../install/deploy-entry" -cf - . | ssh -o BatchMode=yes "root@$host" "set -e; rm -rf '$library'; mkdir -p '$library'; tar -C '$library' --no-same-owner -xf -; chown -R root:root '$library'; chmod -R go-w '$library'; chmod 755 '$library' '$library/himawari-deploy-entry' '$library/shim/ssh' '$library/shim/scp'"

ssh -o BatchMode=yes "root@$host" /bin/bash -s -- "$account" "$library" "$public" <<'REMOTE'
set -euo pipefail
account="$1"; library="$2"; public="$3"
id "$account" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --comment "GitHub deploy, forced command only" "$account"
passwd -l "$account" >/dev/null
home="$(getent passwd "$account" | cut -d: -f6)"
install -d -m 700 -o "$account" -g "$account" "$home/.ssh"
printf 'command="/usr/bin/sudo %s/himawari-deploy-entry",restrict %s\n' "$library" "$public" > "$home/.ssh/authorized_keys"
chown "$account:$account" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
sudoers="/etc/sudoers.d/himawari-deploy"
printf 'Defaults:%s env_keep += "SSH_ORIGINAL_COMMAND"\nDefaults:%s !requiretty\n%s ALL=(root) NOPASSWD: %s/himawari-deploy-entry\n' "$account" "$account" "$account" "$library" > "$sudoers.new"
chmod 440 "$sudoers.new"
/usr/sbin/visudo -cf "$sudoers.new" >/dev/null
mv "$sudoers.new" "$sudoers"
REMOTE

gh api --method PUT "repos/$repo/environments/$environment" --input - >/dev/null <<JSON
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
gh api --method POST "repos/$repo/environments/$environment/deployment-branch-policies" -f name=main -f type=branch >/dev/null 2>&1 || true
gh secret set PROD_SSH_KEY --repo "$repo" --env "$environment" < "$work/key"
gh variable set PROD_HOST --repo "$repo" --env "$environment" --body "$host"
gh variable set PROD_HOST_KEY --repo "$repo" --env "$environment" --body "$host_key"
echo "DEPLOY_KEY_INSTALLED fingerprint=$(ssh-keygen -lf "$work/key.pub" | awk '{print $2}') environment=$environment host=$host account=$account"
