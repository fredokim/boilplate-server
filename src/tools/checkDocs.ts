/**
 * Fails when a document points at something that is not there.
 *
 * Written after an audit found `ARCHITECTURE.md` naming `config/env.validation.ts`
 * for a file that lives at `src/config/env.validation.ts`, and describing the
 * `AUTH_REQUIRED` contract as if one frontend depended on it when all three do.
 * Neither was caught, because nothing looked.
 *
 * Two rules, both mechanical:
 *
 *   1. `npm run x` in a document must be a script in package.json.
 *   2. A backticked repository path must exist.
 *
 * Historical documents are exempt. `prompts/` records how each module was built
 * and describes the layout of the time it was written; rewriting those would
 * destroy the thing they are for. Anything else opts out with the marker below.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const HISTORICAL_MARKER = '<!-- doc-check: historical -->';
const HISTORICAL_DIRS = ['prompts/'];

/** Prefixes that name something in this repository rather than an npm package or a URL. */
const PATH_ROOTS = ['src', 'prisma', 'scripts', 'tools', 'test', 'docs', 'config', 'dist'];

type Problem = { doc: string; kind: 'script' | 'path'; detail: string };

function trackedDocs(): string[] {
  return execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isHistorical(doc: string, text: string): boolean {
  return HISTORICAL_DIRS.some((dir) => doc.startsWith(dir)) || text.includes(HISTORICAL_MARKER);
}

function main(): void {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = new Set(Object.keys(packageJson.scripts ?? {}));
  const problems: Problem[] = [];
  const docs = trackedDocs();

  for (const doc of docs) {
    const text = readFileSync(resolve(ROOT, doc), 'utf8');
    if (isHistorical(doc, text)) continue;

    for (const match of text.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
      const script = match[1];
      if (script === undefined) continue;
      if (!scripts.has(script)) problems.push({ doc, kind: 'script', detail: `npm run ${script}` });
    }

    for (const match of text.matchAll(/`((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.*-]*)`/g)) {
      const candidate = match[1];
      if (candidate === undefined) continue;
      const root = candidate.split('/')[0];
      if (root === undefined || !PATH_ROOTS.includes(root)) continue;
      // Globs and placeholders describe a shape, not a file.
      if (/[*{}<>]/.test(candidate)) continue;
      if (!existsSync(resolve(ROOT, candidate))) problems.push({ doc, kind: 'path', detail: candidate });
    }
  }

  if (problems.length === 0) {
    console.log(`docs:check — ${docs.length} documents, no stale scripts or paths.`);
    return;
  }

  console.error('Documents reference things that do not exist:\n');
  for (const { doc, kind, detail } of problems) {
    console.error(`  ${doc}: ${kind === 'script' ? 'no such script' : 'no such path'} — ${detail}`);
  }
  console.error(
    `\n${problems.length} problem(s). Fix the document, or mark it historical with ${HISTORICAL_MARKER} if it records a past state on purpose.`,
  );
  process.exit(1);
}

main();
