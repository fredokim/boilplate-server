/**
 * Fails when a protocol file declares something nothing speaks.
 *
 * `chatProtocol.ts` declared `ChatClientFrame` — the shape of every message a
 * client may send — and nothing referenced it. The gateway's `parseJoin` wrote
 * its own return type by hand, so the declaration and the parser could drift
 * apart and no check would notice. A type that looks like a contract and
 * enforces nothing is the defect this repository keeps finding in other places;
 * it went unnoticed here for a stage and a half.
 *
 * **Why this is narrow, and stays narrow.** The obvious generalisation — "no
 * unused exports anywhere" — would be wrong for these repositories and actively
 * harmful. A boilerplate ships affordances on purpose: `setLoggerAdapter`,
 * `useBreakpoint`, `withErrorBoundary` are exported for the person who clones
 * it, and nothing in the repository calls them because the caller has not been
 * written yet. Measured across the four repositories there are 94 such exports,
 * and a gate that pressured anyone to delete them would make each boilerplate
 * worse at its only job.
 *
 * The distinction that matters is not "used" versus "unused". It is:
 *
 *   - an affordance a cloner is meant to reach for — keep, deliberately;
 *   - a declaration that claims to be the contract and is wired to nothing.
 *
 * Those cannot be told apart mechanically in general. They can be told apart
 * here, because a protocol file exists for exactly one reason: to be imported by
 * the code that speaks the protocol. If nothing imports it, nothing speaks it.
 *
 * The file list is explicit rather than a glob over `*Protocol.ts`. A glob is
 * a rule about filenames; this is a rule about a handful of files that carry the
 * wire format, and adding one should be a deliberate line in this list rather
 * than a naming accident.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

/** Files whose whole purpose is to be imported by the code that speaks them. */
const PROTOCOL_FILES = [
  'src/live/chat/chatProtocol.ts',
  'src/graph/topology/topologyProtocol.ts',
  'src/realtime/closeCodes.ts',
  'src/common/contracts/errorCode.ts',
];

const EXPORTED = /^export (?:type|const|function|class|interface|enum|abstract class) ([A-Za-z_][A-Za-z0-9_]*)/gm;

function sources(): string[] {
  return execFileSync('git', ['ls-files', 'src/*.ts', 'test/*.ts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes('/generated/'));
}

type Problem = { file: string; symbol: string };

function main(): void {
  const missing = PROTOCOL_FILES.filter((file) => !existsSync(resolve(ROOT, file)));

  if (missing.length > 0) {
    // Renamed or deleted rather than unused. Either is a decision; silently
    // checking nothing is not.
    console.error(`check:protocol — these are listed but not present:\n`);
    for (const file of missing) console.error(`  ${file}`);
    console.error('\nUpdate the list in src/tools/checkProtocolExports.ts.');
    process.exit(2);
  }

  const corpus = new Map<string, string>();

  for (const file of sources()) corpus.set(file, readFileSync(resolve(ROOT, file), 'utf8'));

  const problems: Problem[] = [];
  let checked = 0;

  for (const file of PROTOCOL_FILES) {
    const declarations = [...(corpus.get(file) ?? '').matchAll(EXPORTED)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );

    for (const symbol of declarations) {
      checked += 1;

      /**
       * Every mention anywhere, including inside the declaring file. One means
       * the declaration and nothing else.
       *
       * The first version required a reference *outside* the file and was
       * wrong: `ErrorCodeValue` is the return type of `defaultCodeForStatus`
       * six lines below it, which is real work and no import. The rule is
       * "referenced by something", not "referenced over there".
       *
       * It does not follow chains — a dead type referenced only by another dead
       * type counts as alive. That needs a reference graph; this catches the
       * flat case, which is the one that happened.
       */
      const pattern = new RegExp(`\\b${symbol}\\b`, 'g');
      const mentions = [...corpus.values()].reduce((total, text) => total + (text.match(pattern)?.length ?? 0), 0);

      if (mentions <= 1) problems.push({ file, symbol });
    }
  }

  if (problems.length === 0) {
    console.log(
      `check:protocol — ${String(checked)} declarations across ${String(PROTOCOL_FILES.length)} protocol files, all spoken somewhere.`,
    );
    return;
  }

  console.error(`check:protocol — ${String(problems.length)} declaration(s) nothing speaks:\n`);

  for (const { file, symbol } of problems) console.error(`  ${symbol}  (${file})`);

  console.error(
    '\nWire it into the code that speaks the protocol, or delete it. A protocol file' +
      '\nexists to be imported; a declaration nothing imports is a contract nobody signed.',
  );
  process.exit(1);
}

main();
