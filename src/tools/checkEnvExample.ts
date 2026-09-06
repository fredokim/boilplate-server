/**
 * Fails when the server reads an environment variable that `.env.example` does
 * not mention.
 *
 * The three frontends have carried this check since a Next build refused to
 * start over `NEXT_PUBLIC_DATA_MODE` — a variable its own `.env.example` had
 * never named. This repository did not have the check and had the same problem:
 * `main.ts` reads `TRUST_PROXY`, and nothing told anyone it existed.
 *
 * That one matters more than most. Off by default, and behind a load balancer it
 * must be on, or every request and every session records the balancer's address
 * instead of the client's — which looks like working software and quietly ruins
 * rate limiting and audit logs.
 *
 * Two sources, because this server reads configuration two ways:
 *
 *   1. `process.env.X` directly, mostly in bootstrap before the config module.
 *   2. The validated config schema — the class in `env.validation.ts` *is* the
 *      list of variables this server accepts, so every field on it is checked
 *      whether or not anything reads it through `process.env`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

/**
 * Not variables anyone sets in `.env`. `NODE_ENV` is set by the command that
 * runs the process, and the rest are the platform's own.
 */
const BUILT_IN = new Set(['NODE_ENV', 'PORT', 'CI', 'GITHUB_ACTIONS', 'TZ']);

/** Where the server reads configuration from. Not `test/`: a fixture is not a deployment. */
const SOURCES = ['src', 'prisma'];

function filesUnder(dir: string): string[] {
  return execFileSync('git', ['ls-files', `${dir}/*.ts`], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes('.spec.') && !line.includes('/generated/'));
}

const READ = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

/**
 * Comments are not code.
 *
 * This check failed on its own first CI run, on `process.env.X` written in the
 * docstring above to explain what it looks for. It passed locally only because
 * the file was still untracked and `git ls-files` had never listed it — so the
 * check could not see itself until it was committed, which is a nice way to
 * learn that a mention in prose is not a variable the server reads.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `@IsString() DATABASE_URL!: string;` and friends — the schema names them in full caps. */
const DECLARED = /^\s*(?:@[A-Za-z]+\([^)]*\)\s*)*([A-Z_][A-Z0-9_]*)[!?]?\s*:/gm;

const used = new Map<string, string>();

function note(name: string, where: string): void {
  if (!BUILT_IN.has(name) && !used.has(name)) used.set(name, where);
}

for (const source of SOURCES) {
  for (const file of filesUnder(source)) {
    const contents = withoutComments(readFileSync(resolve(ROOT, file), 'utf8'));

    for (const match of contents.matchAll(READ)) {
      if (match[1]) note(match[1], file);
    }

    if (file.endsWith('env.validation.ts')) {
      for (const match of contents.matchAll(DECLARED)) {
        if (match[1]) note(match[1], file);
      }
    }
  }
}

/** Set or commented out — a commented key still documents the variable. */
const documented = new Set(
  [...readFileSync(resolve(ROOT, '.env.example'), 'utf8').matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  ),
);

const missing = [...used].filter(([name]) => !documented.has(name));

if (missing.length > 0) {
  console.error(`check:env — ${missing.length} variable(s) read but not in .env.example:\n`);

  for (const [name, file] of missing) console.error(`  ${name}  (read in ${file})`);

  console.error('\nAdd them, with a line saying what the value does. A variable nobody documents is one nobody finds.');
  process.exit(1);
}

console.log(`check:env — ${used.size} variable(s) read, all documented in .env.example.`);
