import { expect, test } from 'vitest';
import { requiresCompatibleSupabaseCluster } from '../../packages/connectors/src/postgresql-compatibility.js';

test('actual extension TOC entries require compatible Supabase recovery', () => {
  expect(requiresCompatibleSupabaseCluster('2; 3079 16400 EXTENSION - pg_cron\n')).toBe(true);
  expect(requiresCompatibleSupabaseCluster('3; 3079 16410 EXTENSION - supabase_vault\n')).toBe(
    true,
  );
});
test('ordinary extensions and similarly named application objects remain independently restorable', () => {
  expect(requiresCompatibleSupabaseCluster('2; 3079 16400 EXTENSION - pgcrypto\n')).toBe(false);
  expect(requiresCompatibleSupabaseCluster('2; 1259 16400 TABLE public pg_cron postgres\n')).toBe(
    false,
  );
});
