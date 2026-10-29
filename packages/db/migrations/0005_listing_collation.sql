-- Natural pt-BR ordering must happen before LIMIT/OFFSET, not on a single browser page.
-- PostgreSQL 17 official images include ICU. No rows or existing indexes are changed.
CREATE COLLATION apbackup_pt_numeric (
  provider = icu,
  locale = 'pt-BR-u-kn-true',
  deterministic = true
);
