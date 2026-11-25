FROM base-packer AS packer

FROM base-alpine AS tofu
ARG TOFU_VERSION
ARG TOFU_SHA256
RUN apk add --no-cache curl unzip \
  && curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_amd64.zip" -o /tmp/tofu.zip \
  && echo "$TOFU_SHA256  /tmp/tofu.zip" | sha256sum -c - \
  && unzip -j /tmp/tofu.zip tofu -d /usr/local/bin/ \
  && chmod +x /usr/local/bin/tofu \
  && rm /tmp/tofu.zip \
  && tofu version
ARG XO_PROVIDER_VERSION
ARG XO_PROVIDER_SHA256
RUN curl -fsSL "https://github.com/vatesfr/terraform-provider-xenorchestra/releases/download/v${XO_PROVIDER_VERSION}/terraform-provider-xenorchestra_${XO_PROVIDER_VERSION}_linux_amd64.zip" -o /tmp/xo.zip \
  && echo "$XO_PROVIDER_SHA256  /tmp/xo.zip" | sha256sum -c - \
  && mkdir -p "/opt/tofu-providers/registry.opentofu.org/vatesfr/xenorchestra/${XO_PROVIDER_VERSION}/linux_amd64" \
  && unzip /tmp/xo.zip -d "/opt/tofu-providers/registry.opentofu.org/vatesfr/xenorchestra/${XO_PROVIDER_VERSION}/linux_amd64" \
  && rm /tmp/xo.zip
COPY src/tofu/module/main.tf /tmp/lock/main.tf
RUN cd /tmp/lock \
  && tofu providers lock -fs-mirror=/opt/tofu-providers -platform=linux_amd64 \
  && mkdir -p /opt/tofu-lock \
  && cp .terraform.lock.hcl /opt/tofu-lock/.terraform.lock.hcl \
  && cd / && rm -rf /tmp/lock

FROM base-alpine AS vendor
ARG XEN_GUEST_AGENT_DEB_URL
ARG XEN_GUEST_AGENT_DEB_SHA256
ARG XEN_GUEST_AGENT_RPM_URL
ARG XEN_GUEST_AGENT_RPM_SHA256
ARG CLOUDBASE_INIT_VERSION
ARG CLOUDBASE_INIT_SHA256
RUN apk add --no-cache curl \
  && mkdir -p /vendor/linux /vendor/windows \
  && curl -fsSL "$XEN_GUEST_AGENT_DEB_URL" -o /vendor/linux/xen-guest-agent.deb \
  && curl -fsSL "$XEN_GUEST_AGENT_RPM_URL" -o /vendor/linux/xen-guest-agent.rpm \
  && curl -fsSL "https://github.com/cloudbase/cloudbase-init/releases/download/${CLOUDBASE_INIT_VERSION}/CloudbaseInitSetup_$(echo "$CLOUDBASE_INIT_VERSION" | tr . _)_x64.msi" -o /vendor/windows/CloudbaseInitSetup.msi \
  && printf '%s  %s\n%s  %s\n' "$XEN_GUEST_AGENT_DEB_SHA256" xen-guest-agent.deb "$XEN_GUEST_AGENT_RPM_SHA256" xen-guest-agent.rpm > /vendor/linux/SHA256SUMS \
  && printf '%s  %s\n' "$CLOUDBASE_INIT_SHA256" CloudbaseInitSetup.msi > /vendor/windows/SHA256SUMS \
  && (cd /vendor/linux && sha256sum -c SHA256SUMS) \
  && (cd /vendor/windows && sha256sum -c SHA256SUMS)

FROM base-node
ARG CLOUDBASE_INIT_SHA256
ENV CLOUDBASE_INIT_SHA256=${CLOUDBASE_INIT_SHA256}
ENV VENDOR_DIR=/opt/vendor
RUN apk add --no-cache xorriso git openssh-client curl tini openssl unzip
COPY --from=packer /bin/packer /usr/local/bin/packer
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
COPY --from=tofu /opt/tofu-providers /opt/tofu-providers
COPY --from=tofu /opt/tofu-lock /opt/tofu-lock
COPY --from=vendor /vendor /opt/vendor

WORKDIR /srv/app
COPY package*.json ./
RUN npm ci --omit=dev
COPY migrations ./migrations
COPY src ./src
COPY public ./public
COPY catalogue ./catalogue

RUN printf '#!/bin/sh\ncat /data/initial-admin-password 2>/dev/null || { echo "admin : "; exit 1; }\n' > /usr/local/bin/adminpasswd && chmod 755 /usr/local/bin/adminpasswd
RUN printf '#!/bin/sh\nexec node /srv/app/src/adminreset.js\n' > /usr/local/bin/adminreset && chmod 755 /usr/local/bin/adminreset
RUN mkdir -p /data/jobs-packer /data/jobs-tofu /data/jobs-ansible /data/ansible-work /data/home && chown -R node:node /data
ENV HOME=/data/home
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
