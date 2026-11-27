FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS tools
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
WORKDIR /tmp/tools
RUN set -eu; \
    helm_url="https://get.helm.sh/helm-v3.17.2-linux-${TARGETARCH}.tar.gz"; \
    curl -fsSLo helm.tar.gz "$helm_url"; \
    case "$TARGETARCH" in \
      amd64) checksum=90c28792a1eb5fb0b50028e39ebf826531ebfcf73f599050dbd79bab2f277241 ;; \
      arm64) checksum=d78d76ec7625a94991e887ac049d93f44bd70e4876200b945f813c9e1ed1df7c ;; \
      *) exit 1 ;; \
    esac; \
    echo "$checksum  helm.tar.gz" | sha256sum -c -; \
    tar -xzf helm.tar.gz "linux-${TARGETARCH}/helm"; \
    install -m 0755 "linux-${TARGETARCH}/helm" /usr/local/bin/helm; \
    kubectl_url="https://dl.k8s.io/release/v1.31.4/bin/linux/${TARGETARCH}/kubectl"; \
    curl -fsSLo kubectl "$kubectl_url"; \
    curl -fsSLo kubectl.sha256 "$kubectl_url.sha256"; \
    echo "$(cat kubectl.sha256)  kubectl" | sha256sum -c -; \
    install -m 0755 kubectl /usr/local/bin/kubectl

FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       openssh-server python3 python3-yaml procps iproute2 curl sudo \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && useradd --create-home --shell /bin/bash ops \
    && echo 'ops:detent-e2e-ops' | chpasswd \
    && install -d -o ops -g ops /etc/detent-demo \
    && install -d /run/sshd \
    && printf '%s\n' 'PasswordAuthentication yes' 'PermitRootLogin no' 'AllowUsers ops' \
       > /etc/ssh/sshd_config.d/10-detent.conf

COPY --from=tools /usr/local/bin/helm /usr/local/bin/kubectl /usr/local/bin/
COPY app.conf demo_kafka_server.py /opt/detent-demo/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/detent-target
RUN detent-target reset-config

EXPOSE 22 9092
ENTRYPOINT ["/usr/local/bin/detent-target"]
