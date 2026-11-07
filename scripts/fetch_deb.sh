#!/usr/bin/env bash
# Скачивание deb-пакетов Debian trixie напрямую с deb.debian.org (без root).
set -uo pipefail
cd /tmp
get() { # $1=pool subdir  $2=regex
  local url="https://deb.debian.org/debian/pool/main/$1/"
  local f
  f=$(curl -sS "$url" | grep -oE 'href="[^"]*\.deb"' | sed 's/href="//;s/"//' \
      | grep -E "$2" | grep -E 'amd64\.deb$' | sort -V | tail -1)
  if [ -n "$f" ]; then
    [ -f "$f" ] || curl -sS -o "$f" "$url$f"
    dpkg -x "$f" /tmp/suri-root && echo "OK  $f"
  else
    echo "MISS $1 $2"
  fi
}
get libe/libevent   'libevent-pthreads-2\.1-7_'
get libe/libevent   'libevent-core-2\.1-7t64_'
get libe/libevent   'libevent-pthreads-2\.1-7t64_'
get h/hyperscan     'libhyperscan5_'
get d/device-tree-compiler 'libfdt1_'
get d/dpdk          'librte-eal25_'
get d/dpdk          'librte-log25_'
get d/dpdk          'librte-mbuf25_'
get d/dpdk          'librte-mempool25_'
get d/dpdk          'librte-net25_'
get d/dpdk          'librte-net-bond25_'
get d/dpdk          'librte-ethdev25_'
get d/dpdk          'librte-bus-pci25_'
get d/dpdk          'librte-bus-vdev25_'
get d/dpdk          'librte-hash25_'
get d/dpdk          'librte-ip-frag25_'
get d/dpdk          'librte-kvargs25_'
get d/dpdk          'librte-meter25_'
get d/dpdk          'librte-pci25_'
get d/dpdk          'librte-rcu25_'
get d/dpdk          'librte-ring25_'
get d/dpdk          'librte-sched25_'
get d/dpdk          'librte-telemetry25_'
