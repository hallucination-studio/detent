FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       openssh-server python3 procps iproute2 curl sudo \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && useradd --create-home --shell /bin/bash ops \
    && echo 'ops:detent-e2e-ops' | chpasswd \
    && install -d -o ops -g ops /etc/detent-demo \
    && install -d /run/sshd \
    && printf '%s\n' 'PasswordAuthentication yes' 'PermitRootLogin no' 'AllowUsers ops' \
       > /etc/ssh/sshd_config.d/10-detent.conf

COPY app.conf demo_kafka_server.py /opt/detent-demo/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/detent-target
RUN detent-target reset-config

EXPOSE 22 9092
ENTRYPOINT ["/usr/local/bin/detent-target"]
