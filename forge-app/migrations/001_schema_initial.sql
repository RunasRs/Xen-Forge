CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  is_secret   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE certificate_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK (type IN ('cert_key', 'pkcs12', 'ca')),
  certificate TEXT NOT NULL,
  secret      TEXT NOT NULL DEFAULT '',
  passphrase  TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  issuer      TEXT NOT NULL DEFAULT '',
  not_after   TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE xcp_hosts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host        TEXT NOT NULL UNIQUE,
  username    TEXT NOT NULL,
  password    TEXT NOT NULL,
  insecure    BOOLEAN NOT NULL DEFAULT TRUE,
  role        TEXT NOT NULL DEFAULT 'unknown'
              CHECK (role IN ('master', 'member', 'auth_failed', 'unreachable', 'unknown')),
  reported_master TEXT,
  last_error  TEXT,
  checked_at  TIMESTAMPTZ,
  ca_certificate_id UUID REFERENCES certificate_entries(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX xcp_hosts_single_master ON xcp_hosts ((true)) WHERE role = 'master';

CREATE TABLE profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  vars        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at TIMESTAMPTZ,
  built_at     TIMESTAMPTZ
);

CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action        TEXT NOT NULL CHECK (action IN ('validate', 'build')),
  force_build   BOOLEAN NOT NULL DEFAULT FALSE,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','success','failed','cancelled')),
  vars_snapshot JSONB NOT NULL,
  exit_code     INTEGER,
  log_path      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX jobs_status_idx ON jobs (status, created_at DESC);

CREATE TABLE distribution (
  os      TEXT NOT NULL,
  version TEXT NOT NULL,
  url     TEXT NOT NULL UNIQUE,
  hash    TEXT,
  PRIMARY KEY (os, version)
);

INSERT INTO distribution (os, version, url, hash) VALUES
  ('debian', 'debian12.15.0', 'https://cdimage.debian.org/cdimage/archive/12.15.0/amd64/iso-cd/debian-12.15.0-amd64-netinst.iso', 'cd4462c06aa8892e692c0c4b9c17802f38c8ab8690e85cbfb5ccaa5956e9af17'),
  ('debian', 'debian11.11.0', 'https://cdimage.debian.org/cdimage/archive/11.11.0/amd64/iso-cd/debian-11.11.0-amd64-netinst.iso', 'cd5b2a6fc22050affa1d141adb3857af07e94ff886dca1ce17214e2761a3b316'),
  ('debian', 'debian13.7.0', 'https://cdimage.debian.org/cdimage/archive/13.7.0/amd64/iso-cd/debian-13.7.0-amd64-netinst.iso', 'a7ef94ac2fb9a7fec454552abd629b7cc9d5155c886165a45649f5ce6167e355'),
  ('kali', 'kali2026.3', 'https://old.kali.org/kali-images/kali-2026.3/kali-linux-2026.3-installer-netinst-amd64.iso', '0dd3e70f2e0b092286b29355450bc79a034a13fb1d5b4bf83c297149115258cd'),
  ('ubuntu', 'ubuntu26.04.1', 'https://releases.ubuntu.com/26.04.1/ubuntu-26.04.1-live-server-amd64.iso', 'cc8a95cde20f6ced61a322420de00f10cc3c90ced545daa46cb9c1a117f1d927'),
  ('ubuntu', 'ubuntu24.04.5', 'https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-live-server-amd64.iso', '97f3d7ffb032c3eb3b23d2c8be9cc76e60c2c1f2c0146ba5ba9fe01cafae0fd8'),
  ('ubuntu', 'ubuntu26.10', 'https://releases.ubuntu.com/26.10/ubuntu-26.10-live-server-amd64.iso', 'c8e9d797f718404bdb1e282f8466fe6f5f2e9f03c814bdf11b31326d45200929'),
  ('almalinux', 'almalinux9', 'https://vault.almalinux.org/9.8/isos/x86_64/AlmaLinux-9.8-x86_64-boot.iso', '445f99e24399bbe98aab86111d60751c142eda049d2444fd76da5eb03472e4ab'),
  ('almalinux', 'almalinux8', 'https://repo.almalinux.org/almalinux/8/isos/x86_64/AlmaLinux-8.10-x86_64-boot.iso', 'cc3e61faf2dd6c9c80d3beeb47eaaba235ac13fe1b617209c3c1e546528ccb99'),
  ('almalinux', 'almalinux10', 'https://vault.almalinux.org/10.2/isos/x86_64/AlmaLinux-10.2-x86_64-boot.iso', 'b3f865468075bcada8f208d830289302c67529789d668041d24e8d6fc697ba6a'),
  ('windows', 'windows2025', 'https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.32230.260111-0550.lt_release_svc_refresh_SERVER_EVAL_x64FRE_fr-fr.iso', 'f7ab045c3680f3d4a0cc826b68a947e8253a617dec8e2bbfc221201cfe2bd2b7'),
  ('windows', 'windows2022', 'https://software-static.download.prss.microsoft.com/sg/download/888969d5-f34g-4e03-ac9d-1f9786c66749/SERVER_EVAL_x64FRE_fr-fr.iso', 'a32de43bd5201f3665d323d3f384c6eec4091e8b7eb4e7f35ae18455274e3ee8'),
  ('windows', 'windows2019', 'https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66749/17763.3650.221105-1748.rs5_release_svc_refresh_SERVER_EVAL_x64FRE_fr-fr.iso', '6a2b373321408f8509151b00daf07bea4fe7fd7d7c3435415b2d0cc0117a11ff'),
  ('fedora', 'fedora44', 'https://download.fedoraproject.org/pub/fedora/linux/releases/44/Server/x86_64/iso/Fedora-Server-netinst-x86_64-44-1.7.iso', 'ae20c06bea746913cadea7d80463e13f4bf55bee4df2918111c921c674b70283'),
  ('fedora', 'fedora43', 'https://download.fedoraproject.org/pub/fedora/linux/releases/43/Server/x86_64/iso/Fedora-Server-netinst-x86_64-43-1.6.iso', '16fd70ddae2c7de13e485637c3da1fb385dd8220389f988279ea3b3d561243cc'),
  ('fedora', 'fedora42', 'https://download.fedoraproject.org/pub/fedora/linux/releases/42/Server/x86_64/iso/Fedora-Server-netinst-x86_64-42-1.1.iso', '231f3e0d1dc8f565c01a9f641b3d16c49cae44530074bc2047fe2373a721c82f'),
  ('oracle', 'oracle8U10', 'https://yum.oracle.com/ISOS/OracleLinux/OL8/u10/x86_64/OracleLinux-R8-U10-x86_64-boot.iso', 'c7009ca2b28ddbedd6c09fc9141f933dec01a6ea73c503634786809746af1906'),
  ('oracle', 'oracle9U8', 'https://yum.oracle.com/ISOS/OracleLinux/OL9/u8/x86_64/OracleLinux-R9-U8-x86_64-boot.iso', 'fec471a2f0324e958d18a55e8704a61cd39a49f029448699664bd4e97496dd5f'),
  ('oracle', 'oracle10U2', 'https://yum.oracle.com/ISOS/OracleLinux/OL10/u2/x86_64/OracleLinux-R10-U2-x86_64-boot.iso', 'b15149fe6691844cfb82c764d6e79f97f9856286ea648ee45809bc5a4fa79aee'),
  ('opensuse', 'opensuse15.6', 'https://download.opensuse.org/distribution/leap/15.6/iso/openSUSE-Leap-15.6-NET-x86_64-Build710.3-Media.iso', '0984b36d0f420487f2766733ff8f9d779ade81d432b08e40e852a675313750bb'),
  ('opensuse', 'opensuse16.1', 'https://download.opensuse.org/distribution/leap/16.1/installer/iso/agama-installer.x86_64-24.0.0-Leap_16.1-Build60.2.iso', '4a7049d657ac08b54cfc6321a81aeeb043f562702fcde363037ec15bf0645093'),
  ('rocky', 'rocky9', 'https://dl.rockylinux.org/vault/rocky/9.8/isos/x86_64/Rocky-9.8-x86_64-boot.iso', 'd6eeefdc8437c593d41a3150fcca4a734c55642ed472eecdda99720bb1370881'),
  ('rocky', 'rocky8', 'https://download.rockylinux.org/pub/rocky/8/isos/x86_64/Rocky-8.10-x86_64-boot.iso', '5987b4b0bdbb3189e91248353d45e0bf37f05747b0ba746664a2d1e8e7936ed7'),
  ('rocky', 'rocky10', 'https://dl.rockylinux.org/vault/rocky/10.2/isos/x86_64/Rocky-10.2-x86_64-boot.iso', 'bf3a75907948563d0c11f3d1b8546ee9216e18a3ea2dc0a67eb4c45452e210f9');

CREATE TABLE tofu_profiles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  vars         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  planned_at   TIMESTAMPTZ,
  applied_at   TIMESTAMPTZ,
  destroyed_at TIMESTAMPTZ
);

CREATE TABLE tofu_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    UUID REFERENCES tofu_profiles(id) ON DELETE SET NULL,
  action        TEXT NOT NULL CHECK (action IN ('plan', 'apply', 'import', 'destroy')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','success','failed','cancelled')),
  vars_snapshot JSONB NOT NULL,
  exit_code     INTEGER,
  log_path      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX tofu_jobs_status_idx ON tofu_jobs (status, created_at DESC);

CREATE TABLE safe_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('password', 'ssh_key', 'product_key')),
  username    TEXT NOT NULL DEFAULT '',
  secret      TEXT NOT NULL,
  public_key  TEXT NOT NULL DEFAULT '',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, type)
);

CREATE TABLE totp_users (
  username         TEXT PRIMARY KEY,
  user_type        TEXT NOT NULL CHECK (user_type IN ('local', 'domain')),
  secret_encrypted TEXT NOT NULL,
  totp_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  totp_created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  totp_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  max_attempts        INTEGER NOT NULL DEFAULT 5,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO auth_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE local_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  password_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ldap_configs (
  id              SERIAL PRIMARY KEY,
  domain          TEXT NOT NULL UNIQUE,
  server          TEXT NOT NULL,
  bind_dn         TEXT,
  bind_password   TEXT,
  base_dn         TEXT NOT NULL,
  attribute       TEXT NOT NULL DEFAULT 'sAMAccountName',
  tls             BOOLEAN NOT NULL DEFAULT FALSE,
  ldaps           BOOLEAN NOT NULL DEFAULT FALSE,
  ca_certificate_id UUID REFERENCES certificate_entries(id) ON DELETE RESTRICT,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  tls_name        TEXT
);

CREATE TABLE ldap_admins (
  id        SERIAL PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('user', 'group')),
  name      TEXT NOT NULL,
  dn        TEXT,
  enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  config_id INTEGER NOT NULL REFERENCES ldap_configs(id) ON DELETE CASCADE,
  UNIQUE (kind, name)
);

CREATE TABLE ldap_accounts (
  id            SERIAL PRIMARY KEY,
  config_id     INTEGER NOT NULL REFERENCES ldap_configs(id) ON DELETE CASCADE,
  username      TEXT NOT NULL,
  last_login_at TIMESTAMPTZ,
  via_group     TEXT
);
CREATE UNIQUE INDEX ldap_accounts_login ON ldap_accounts (config_id, lower(username));

CREATE TABLE audit_log (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  event     TEXT NOT NULL,
  actor     TEXT NOT NULL CHECK (actor IN ('user', 'system', 'anonymous')),
  username  TEXT,
  ip        TEXT,
  outcome   TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'refused', 'error')),
  status    INTEGER,
  target    TEXT,
  details   JSONB
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_event_idx ON audit_log (event, at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (username, at DESC);

CREATE TABLE sessions (
  jti           UUID PRIMARY KEY,
  username      TEXT NOT NULL,
  type          TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trusted_devices (
  token_hash    TEXT NOT NULL,
  account       TEXT NOT NULL,
  failures      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_hash, account)
);

CREATE TABLE totp_enrollment (
  account    TEXT PRIMARY KEY,
  open_until TIMESTAMPTZ NOT NULL
);

CREATE TABLE ansible_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  vars        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at  TIMESTAMPTZ,
  applied_at  TIMESTAMPTZ
);

CREATE TABLE ansible_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    UUID REFERENCES ansible_profiles(id) ON DELETE SET NULL,
  action        TEXT NOT NULL CHECK (action IN ('ping', 'check', 'apply')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','success','failed','cancelled')),
  vars_snapshot JSONB NOT NULL,
  recap         JSONB,
  exit_code     INTEGER,
  log_path      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX ansible_jobs_status_idx ON ansible_jobs (status, created_at DESC);

CREATE TABLE ansible_known_hosts (
  host       TEXT PRIMARY KEY,
  keys       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  profile_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  mode         TEXT NOT NULL CHECK (mode IN ('once', 'recurring')),
  run_date     DATE,
  weekdays     SMALLINT[],
  weeks        SMALLINT[],
  run_time     TIME NOT NULL,
  timezone     TEXT NOT NULL,
  next_run_at  TIMESTAMPTZ,
  last_run_at  TIMESTAMPTZ,
  last_job_id  UUID REFERENCES jobs(id) ON DELETE SET NULL,
  last_outcome TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  action       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((mode = 'once' AND run_date IS NOT NULL AND weekdays IS NULL AND weeks IS NULL)
    OR (mode = 'recurring' AND run_date IS NULL AND cardinality(weekdays) > 0))
);
CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX schedules_profile_idx ON schedules (profile_id);

CREATE TABLE ansible_schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  profile_id   UUID NOT NULL REFERENCES ansible_profiles(id) ON DELETE RESTRICT,
  mode         TEXT NOT NULL CHECK (mode IN ('once', 'recurring')),
  run_date     DATE,
  weekdays     SMALLINT[],
  weeks        SMALLINT[],
  run_time     TIME NOT NULL,
  timezone     TEXT NOT NULL,
  next_run_at  TIMESTAMPTZ,
  last_run_at  TIMESTAMPTZ,
  last_job_id  UUID REFERENCES ansible_jobs(id) ON DELETE SET NULL,
  last_outcome TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  action       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((mode = 'once' AND run_date IS NOT NULL AND weekdays IS NULL AND weeks IS NULL)
    OR (mode = 'recurring' AND run_date IS NULL AND cardinality(weekdays) > 0))
);
CREATE INDEX ansible_schedules_due_idx ON ansible_schedules (next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX ansible_schedules_profile_idx ON ansible_schedules (profile_id);

CREATE TABLE tofu_schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  profile_id   UUID NOT NULL REFERENCES tofu_profiles(id) ON DELETE RESTRICT,
  mode         TEXT NOT NULL CHECK (mode IN ('once', 'recurring')),
  run_date     DATE,
  weekdays     SMALLINT[],
  weeks        SMALLINT[],
  run_time     TIME NOT NULL,
  timezone     TEXT NOT NULL,
  next_run_at  TIMESTAMPTZ,
  last_run_at  TIMESTAMPTZ,
  last_job_id  UUID REFERENCES tofu_jobs(id) ON DELETE SET NULL,
  last_outcome TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  action       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((mode = 'once' AND run_date IS NOT NULL AND weekdays IS NULL AND weeks IS NULL)
    OR (mode = 'recurring' AND run_date IS NULL AND cardinality(weekdays) > 0))
);
CREATE INDEX tofu_schedules_due_idx ON tofu_schedules (next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX tofu_schedules_profile_idx ON tofu_schedules (profile_id);
