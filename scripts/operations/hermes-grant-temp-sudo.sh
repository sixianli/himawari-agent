#!/bin/bash
set -euo pipefail

MINUTES=${1:-}
GRANTEE=andy
RULE=/etc/sudoers.d/90-claude-temp
UNIT=claude-temp-sudo-expire

if ! [[ "$MINUTES" =~ ^[0-9]+$ ]] || [ "$MINUTES" -lt 1 ] || [ "$MINUTES" -gt 120 ]; then
  echo "usage: sudo bash hermes-grant-temp-sudo.sh <minutes 1-120>" >&2
  exit 64
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "run it with sudo" >&2
  exit 65
fi

EXPIRE=$(date -d "+${MINUTES} minutes" '+%Y-%m-%d %H:%M:%S')

cat > /etc/systemd/system/$UNIT.service <<EOF
[Unit]
Description=Remove the temporary sudo rule for $GRANTEE

[Service]
Type=oneshot
ExecStart=/bin/rm -f $RULE
EOF

cat > /etc/systemd/system/$UNIT.timer <<EOF
[Unit]
Description=Remove the temporary sudo rule for $GRANTEE at $EXPIRE

[Timer]
OnCalendar=$EXPIRE
Persistent=true
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now $UNIT.timer
systemctl restart $UNIT.timer

CANDIDATE=$(mktemp)
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$GRANTEE" > "$CANDIDATE"
visudo -cf "$CANDIDATE" > /dev/null
install -m 0440 -o root -g root "$CANDIDATE" "$RULE"
rm -f "$CANDIDATE"

echo "TEMP_SUDO_GRANTED user=$GRANTEE until=$EXPIRE"
systemctl list-timers $UNIT.timer --no-pager
echo "revoke now: sudo rm -f $RULE"
