import fs from 'node:fs';
import path from 'node:path';
const directory = 'apps/web/.output/public';
const files = [];
function visit(p) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) visit(f);
    else if (/\.(js|html)$/.test(f)) files.push(f);
  }
}
visit(directory);
const forbidden = [
  /AUTH_SECRET/,
  /DATABASE_URL/,
  /auth_accounts/,
  /auth_sessions/,
  /pg-protocol/,
  /createAuth\(/,
  /consumeRateLimit/,
  /drizzle-orm/,
  /disposable-browser-secret-for-tests-only/,
];
let failures = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const pattern of forbidden)
    if (pattern.test(source)) {
      console.error(`${file}: forbidden server boundary ${pattern}`);
      failures++;
    }
}
if (files.length === 0) throw new Error('No browser artifacts were built');
if (failures) process.exitCode = 1;
else
  console.log(
    `Client boundary verified: ${files.length} emitted browser artifacts, no privileged configuration, SQL/auth storage or database-driver signatures.`,
  );
