// --check gate: the committed golden pact must be exactly what postman-to-pact
// emits from the committed consumer collection (Decision D5 determinism). Fails on
// drift, like the roadmap-index / manifest gates elsewhere in the estate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDoc } from '../src/lib/load.mjs';
import { serialize } from '../src/lib/pact.mjs';
import { postmanToPact } from '../src/postman-to-pact.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COLLECTION = join(ROOT, 'fixtures', 'checkout-app-collection.json');
const GOLDEN = join(ROOT, 'fixtures', 'checkout-app.pact.json');

const rendered = serialize(postmanToPact(loadDoc(COLLECTION), { provider: 'paypal-orders' }));
let committed;
try {
  committed = readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n');
} catch {
  console.error(`[check] FAILED: ${GOLDEN} missing. Regenerate: node src/cli.mjs postman-to-pact --collection fixtures/checkout-app-collection.json --provider paypal-orders --out fixtures/checkout-app.pact.json`);
  process.exit(1);
}
if (committed !== rendered) {
  console.error('[check] FAILED: fixtures/checkout-app.pact.json is out of sync with the collection. Regenerate it.');
  process.exit(1);
}
console.log('[check] passed: golden pact matches the collection.');
