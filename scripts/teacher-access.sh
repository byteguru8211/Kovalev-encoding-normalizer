#!/usr/bin/env bash
# Open full root SSH access for the course review over Tailscale.
# Run on the course machine:  sudo bash scripts/teacher-access.sh
# Revoke afterwards:          sudo bash scripts/teacher-access-stop.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/teacher-access.sh" >&2
  exit 1
fi

echo "==> Configuring sshd for root access during the review"
install -m 0644 /dev/stdin /etc/ssh/sshd_config.d/99-course-review.conf <<'EOF'
PermitRootLogin yes
PasswordAuthentication yes
PubkeyAuthentication yes
EOF
sshd -t
systemctl restart ssh

echo "==> Checking the root password"
ROOT_STATUS="$(passwd -S root | awk '{print $2}')"
if [[ "$ROOT_STATUS" == "L" || "$ROOT_STATUS" == "" ]]; then
  echo "Root has no usable password. Set it now (input is hidden)."
  passwd root
else
  echo "Root password is already set. If it is unknown, rerun: passwd root"
fi

echo "==> Bringing Tailscale up"
systemctl enable --now tailscaled
if tailscale ip -4 >/dev/null 2>&1 && tailscale status --peers=false >/dev/null 2>&1; then
  echo "Tailscale already connected."
else
  # --reset clears any stale non-default flags (e.g. a previously set exit-node)
  # that would otherwise make 'tailscale up' refuse to run. operator lets the
  # student read 'tailscale status' without sudo.
  tailscale up --reset --operator="$(logname 2>/dev/null || echo byteguru)" --timeout=180s \
    || { echo "Login was not completed. Run 'sudo tailscale up' and open the printed link." >&2; exit 1; }
fi

TS_IP="$(tailscale ip -4)"
HOSTNAME_CLEAN="$(hostname)"
echo
echo "================= ACCESS FOR THE REVIEWER ================="
echo "Web page   : http://${TS_IP}/"
echo "API health : http://${TS_IP}/api/health"
echo "SSH (root) : ssh root@${TS_IP}     (password set above)"
echo "Hostname   : ${HOSTNAME_CLEAN}"
echo "Tailscale  : $(tailscale status --peers=false | head -1)"
echo
echo "Give the reviewer a Tailscale share/invite for this tailnet,"
echo "then the root SSH password personally. Revoke with:"
echo "  sudo bash scripts/teacher-access-stop.sh"
echo "==========================================================="
