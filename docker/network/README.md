# Sandbox network: `gcr-egress`

The per-review sandbox container attaches to a custom Docker bridge whose
egress is restricted to **`api.anthropic.com:443` only**. Everything else is
denied.

This is enforced **outside** the container — iptables on the host's bridge
interface — so the sandbox cannot lift it even if the agent inside is
compromised.

## Create the bridge

```bash
docker network create \
  --driver=bridge \
  --opt com.docker.network.bridge.name=gcr-egress \
  --subnet=172.30.0.0/24 \
  gcr-egress
```

## Resolve api.anthropic.com once

GitHub Actions (and most home networks) resolve the hostname dynamically. We
allow by IP, refreshed nightly by a cron rule. For initial setup:

```bash
ANTHROPIC_IPS=$(getent hosts api.anthropic.com | awk '{print $1}' | sort -u)
echo "$ANTHROPIC_IPS"
```

## Apply the firewall

```bash
# 1. allow established traffic back in
sudo iptables -I DOCKER-USER -i gcr-egress -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# 2. allow DNS to a single internal resolver (e.g. the host)
sudo iptables -I DOCKER-USER -i gcr-egress -p udp --dport 53 -d 172.30.0.1 -j ACCEPT

# 3. allow https to anthropic IPs only
for ip in $ANTHROPIC_IPS; do
  sudo iptables -I DOCKER-USER -i gcr-egress -p tcp -d "$ip" --dport 443 -j ACCEPT
done

# 4. drop everything else from the bridge
sudo iptables -A DOCKER-USER -i gcr-egress -j DROP
```

## Persist across reboots

Save with `iptables-save > /etc/iptables/gcr.v4` and load via `netfilter-persistent`
(or your distro's equivalent). On NixOS the setup is two lines in
`networking.firewall.extraCommands`.

## Verify

The opt-in `tests/sandbox/egress.test.ts` test launches the sandbox image,
attempts to curl `https://example.com` (expected to fail) and `api.anthropic.com`
(expected to succeed), and asserts the right outcomes.

## Future work

A nicer story is replacing the iptables setup with a sidecar HTTP forward
proxy that allow-lists hostnames. That ADR is deferred to post-1.0; iptables
is the right "boring, observable, swappable" baseline for M2.
