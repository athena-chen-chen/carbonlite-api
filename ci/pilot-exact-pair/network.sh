#!/usr/bin/env bash
set -euo pipefail
# Only the dedicated test UID is filtered; Actions itself retains artifact access.
uid=24001
case "${1:?}" in
  enable)
    test "$(id -u clpairtest)" = "$uid"
    sudo iptables -N CLPAIR_EGRESS
    sudo ip6tables -N CLPAIR_EGRESS
    sudo iptables -A CLPAIR_EGRESS -o lo -j RETURN
    sudo ip6tables -A CLPAIR_EGRESS -o lo -j RETURN
    # Docker DNAT can replace loopback destinations before OUTPUT filtering.
    for container in "${POSTGRES_CONTAINER:?}" "${POOLER_CONTAINER:?}"; do
      address="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container")"
      [[ "$address" =~ ^172\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
      sudo iptables -A CLPAIR_EGRESS -d "$address" -p tcp --dport 5432 -j RETURN
    done
    # Header-only metadata, bounded rate; no request contents or DNS payloads.
    sudo iptables -A CLPAIR_EGRESS -m limit --limit 30/minute --limit-burst 20 -j LOG --log-prefix 'CLPAIR_DENY ' --log-uid
    sudo ip6tables -A CLPAIR_EGRESS -m limit --limit 30/minute --limit-burst 20 -j LOG --log-prefix 'CLPAIR_DENY ' --log-uid
    sudo iptables -A CLPAIR_EGRESS -j REJECT
    sudo ip6tables -A CLPAIR_EGRESS -j REJECT
    sudo iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -j CLPAIR_EGRESS
    sudo ip6tables -I OUTPUT 1 -m owner --uid-owner "$uid" -j CLPAIR_EGRESS
    ;;
  check)
    # These command failures MUST fail the step, never imply a zero count.
    v4="$(sudo iptables -L CLPAIR_EGRESS -n -v -x)"
    v6="$(sudo ip6tables -L CLPAIR_EGRESS -n -v -x)"
    blocked="$(printf '%s\n%s\n' "$v4" "$v6" | awk '$3=="REJECT" {sum+=$1; lines++} END {if(lines!=2) exit 1; print sum+0}')"
    printf 'BLOCKED_EXTERNAL_PACKETS: %s\n' "$blocked"
    test "$blocked" = 0
    ;;
  *) exit 1 ;;
esac
# Rules remain until the disposable runner is destroyed. Never reopen test egress.
