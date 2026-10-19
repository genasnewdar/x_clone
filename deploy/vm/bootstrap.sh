#!/usr/bin/env bash
# Run ON the VM (Debian 12) once: installs Docker, unattended security updates,
# and a basic host firewall. Usage: sudo bash bootstrap.sh
set -euo pipefail

apt-get update
apt-get install -y ca-certificates curl gnupg git unattended-upgrades ufw

# Automatic security patches.
dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker from Docker's own repository.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Docker log rotation (unbounded logs are a classic way to fill a disk).
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
JSON
systemctl restart docker

# Host firewall as a second layer behind the GCP firewall.
# NOTE: Docker-published ports bypass ufw; that's fine here because only
# Caddy publishes ports (80/443) and we want those open.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "Done. Log out and back in after: sudo usermod -aG docker \$USER"
