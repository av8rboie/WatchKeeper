// Writes the committed sample replay fixtures. Longer fixtures (the 2-hour
// recorder test) are generated at test time from the same generator.
//
//   pnpm --filter @watchkeeper/server exec tsx scripts/make-fixtures.ts

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generate, writeFixture } from '../test/helpers/fixtures.js';

const dir = join(import.meta.dirname, '..', 'test', 'fixtures');
mkdirSync(dir, { recursive: true });
writeFixture(join(dir, 'passage-2min.jsonl'), generate({ seconds: 120 }));
writeFixture(join(dir, 'dead-depth-2min.jsonl'), generate({ seconds: 120, dead: ['environment.depth.belowKeel'], deadAfterS: 30 }));
console.log(`fixtures written to ${dir}`);
