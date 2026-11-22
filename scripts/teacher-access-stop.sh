#!/usr/bin/env bash
# Revoke the reviewer's root SSH access and take the machine off Tailscale.
# Run on the course machine:  sudo bash scripts/teacher-access-stop.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/teacher-access-stop.sh" >&2
  exit 1
fi

echo "==> Restoring default sshd policy (no root password login)"
rm -f /etc/ssh/sshd_config.d/99-course-review.conf
sshd -t
systemctl restart ssh

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  echo "==> Taking the machine off Tailscale"
  tailscale down
fi

passwd -l root >/dev/null 2>&1 || true
echo "Done: root SSH password login is closed, Tailscale is down,"
echo "root account is locked again (personal sudo user is unaffected)."
