/** `pnpm --filter @bookrail/node generate`: writes `src/generated/openapi.ts`. */
import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { GENERATED_PATH, renderGenerated } from './render.js';

async function main(): Promise<void> {
  const next = await renderGenerated();
  const current = await readFile(GENERATED_PATH, 'utf8').catch(() => null);
  const where = relative(process.cwd(), GENERATED_PATH);
  if (current === next) {
    console.error(`unchanged: ${where} (${String(next.split('\n').length)} lines)`);
    return;
  }
  await writeFile(GENERATED_PATH, next, 'utf8');
  console.error(`written: ${where} (${String(next.split('\n').length)} lines)`);
}

await main();
