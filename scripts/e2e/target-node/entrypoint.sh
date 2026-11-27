#!/bin/bash
set -eu

if [[ ${1:-} == reset-config ]]; then
    install -d -o ops -g ops /etc/detent-demo
    exec install -o ops -g ops -m 0644 /opt/detent-demo/app.conf /etc/detent-demo/app.conf
fi

install -d -m 0700 -o ops -g ops /home/ops/.kube
install -m 0600 /k3s-kubeconfig/kubeconfig.yaml /home/ops/.kube/config
sed -i 's@https://127\.0\.0\.1:6443@https://k3s:6443@g' /home/ops/.kube/config
chown -R ops:ops /home/ops/.kube

ssh-keygen -A
/usr/sbin/sshd -t
# The SSH user can see its own listener's PID and process name in ss -lntp.
setpriv --reuid=ops --regid=ops --init-groups python3 /opt/detent-demo/demo_kafka_server.py --port 9092 &
listener=$!
/usr/sbin/sshd -D -e &
sshd=$!
trap 'kill "$listener" "$sshd" 2>/dev/null || true' EXIT
trap 'exit 0' INT TERM
wait -n
