FROM base-python
ARG ANSIBLE_CORE_VERSION
ARG ANSIBLE_RUNNER_VERSION
ARG PYWINRM_VERSION
ARG ANSIBLE_POSIX_VERSION
ARG COMMUNITY_GENERAL_VERSION
ARG ANSIBLE_WINDOWS_VERSION
ARG COMMUNITY_WINDOWS_VERSION
ARG MICROSOFT_AD_VERSION
ARG COMMUNITY_CRYPTO_VERSION

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
  ANSIBLE_COLLECTIONS_PATH=/usr/share/ansible/collections
RUN apk add --no-cache openssh-client sshpass tini \
  && pip install --root-user-action=ignore "ansible-core==${ANSIBLE_CORE_VERSION}" "ansible-runner==${ANSIBLE_RUNNER_VERSION}" "pywinrm==${PYWINRM_VERSION}" \
  && ansible-galaxy collection install -p "$ANSIBLE_COLLECTIONS_PATH" \
    "ansible.posix:==${ANSIBLE_POSIX_VERSION}" \
    "community.general:==${COMMUNITY_GENERAL_VERSION}" \
    "ansible.windows:==${ANSIBLE_WINDOWS_VERSION}" \
    "community.windows:==${COMMUNITY_WINDOWS_VERSION}" \
    "microsoft.ad:==${MICROSOFT_AD_VERSION}" \
    "community.crypto:==${COMMUNITY_CRYPTO_VERSION}" \
  && rm -rf /root/.ansible \
  && addgroup -g 1000 forge \
  && adduser -D -H -u 1000 -G forge -h /tmp forge \
  && mkdir -p /data/ansible-work \
  && chown forge:forge /data/ansible-work \
  && chmod 700 /data/ansible-work \
  && ansible --version \
  && ansible-runner --version

COPY supervisor.py /opt/forge/supervisor.py

ENV HOME=/tmp \
  ANSIBLE_NOCOLOR=1 \
  ANSIBLE_HOST_KEY_CHECKING=True \
  ANSIBLE_FORCE_COLOR=0 \
  ANSIBLE_RETRY_FILES_ENABLED=0 \
  ANSIBLE_LOCAL_TEMP=/tmp/ansible-local \
  ANSIBLE_SSH_CONTROL_PATH_DIR=/tmp/ansible-cp \
  ANSIBLE_INVENTORY_UNPARSED_FAILED=1 \
  ANSIBLE_INVENTORY_ENABLED=yaml \
  ANSIBLE_DEPRECATION_WARNINGS=0 \
  WORK_DIR=/data/ansible-work

USER forge
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["python3", "/opt/forge/supervisor.py"]
