/**
 * One command that says whether this repository is ready to ship.
 *
 * Everything here already existed as an npm script. This adds no new checking —
 * it adds an order, a name for each gate, and a report. The gates are the same
 * ones CI runs, from this list, so the two cannot drift into disagreeing about
 * what "green" means.
 *
 * **Why not `a && b && c`.** `check` was a chain joined with `&&`, and it has one
 * failure mode that matters: it stops at the first problem and buries which one
 * it was in several hundred lines of output. So this runs every gate, captures
 * each one's output separately, and ends with a table. One run tells you
 * everything that is wrong, not the first thing.
 *
 * **Skipping is a result, not a pass.** A gate that needs PostgreSQL or Docker
 * and cannot find it reports `skipped` with the reason, and the summary refuses
 * to say "ready". Reporting readiness from a run where the migration gates never
 * executed is the failure this whole refactor has been about.
 *
 * **The gate list is not the frontends' list**, deliberately. There is no bundle
 * budget and no Storybook here, and there is a schema, a migration history and a
 * published specification that they do not have. Forcing the four repositories
 * to run the same gates would mean either checking things that do not exist or
 * dropping the ones that matter most.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

type Gate = {
  /** Short, stable, and what the summary prints. */
  name: string;
  /** What it proves. Printed when it fails, so the failure explains itself. */
  proves: string;
  command: string;
  args: string[];
  /** Heavy gates are skipped by `--quick`, which is the fast local loop. */
  heavy?: boolean;
  /** Returns a reason to skip, or null to run. */
  unavailable?: () => string | null;
};

const npm = (script: string): Pick<Gate, 'command' | 'args'> => ({
  command: 'npm',
  args: ['run', script],
});

const shell = process.platform === 'win32';

function toolMissing(tool: string, args: string[] = ['--version']): string | null {
  return spawnSync(tool, args, { stdio: 'ignore', shell }).status === 0 ? null : `${tool} is not available on this machine`;
}

/**
 * The integration and migration gates need a real PostgreSQL, not a mock.
 *
 * In CI they are skipped even though `DATABASE_URL` is set — the value there
 * exists so `prisma validate` has a URL to parse, and nothing is listening on
 * it. The `integration` job below stands up a real server and runs both.
 */
function databaseMissing(): string | null {
  if (process.env.GITHUB_ACTIONS === 'true') return 'covered by the integration job';

  return process.env.DATABASE_URL ? null : 'DATABASE_URL is not set, so there is no database to migrate against';
}

/**
 * Cheap and structural first, so a stale document or an unformatted schema is
 * reported in seconds rather than after the end-to-end suite.
 *
 * Installing from a clean state is not among them. `npm ci` is the step CI runs
 * before this, and doing it locally would delete a working node_modules to
 * prove something the lockfile already decides.
 */
const GATES: readonly Gate[] = [
  {
    name: 'schema-format',
    proves: 'the Prisma schema is formatted as Prisma writes it',
    command: 'npx',
    args: ['prisma', 'format', '--check'],
  },
  {
    name: 'schema-valid',
    proves: 'the Prisma schema is valid',
    command: 'npx',
    args: ['prisma', 'validate'],
  },
  {
    name: 'doc-links',
    proves: 'every document resolves its links and is reachable from the README',
    ...npm('docs:check'),
  },
  {
    name: 'env-contract',
    proves: 'every variable the server reads is documented in .env.example',
    ...npm('check:env'),
  },
  { name: 'lint', proves: 'the code passes the lint rules with no warnings', ...npm('lint') },
  { name: 'typecheck', proves: 'the types are sound', ...npm('typecheck') },
  { name: 'unit', proves: 'the unit tests pass', ...npm('test') },
  {
    name: 'e2e',
    proves: 'the HTTP surface behaves — envelope, auth, health, and the module routes',
    ...npm('test:e2e'),
  },
  { name: 'build', proves: 'the server compiles', ...npm('build') },
  {
    name: 'openapi-drift',
    proves: 'the committed openapi.json matches the code — three frontends test against it',
    command: 'node',
    args: ['dist/tools/checkOpenApiDrift.js'],
  },
  {
    name: 'audit',
    proves: 'no shipped dependency carries a known moderate-or-worse advisory',
    command: 'npm',
    // `--omit=dev`, with the reason recorded in DEVELOPMENT_POLICY.md.
    args: ['audit', '--omit=dev', '--audit-level=moderate'],
  },
  {
    name: 'integration',
    proves: 'the repository layer behaves against a real PostgreSQL',
    heavy: true,
    unavailable: databaseMissing,
    ...npm('test:integration'),
  },
  {
    name: 'migrations',
    proves: 'the migration history applies cleanly and agrees with the schema',
    heavy: true,
    unavailable: databaseMissing,
    command: 'npx',
    args: ['prisma', 'migrate', 'status'],
  },
  {
    name: 'image',
    proves: 'the production image builds — this is what Render deploys',
    heavy: true,
    unavailable: () =>
      // In CI the `docker` job builds this image, runs it, and checks the
      // migration step is runnable inside it — strictly more than a build.
      process.env.GITHUB_ACTIONS === 'true' ? 'covered by the docker job' : toolMissing('docker'),
    command: 'docker',
    args: ['build', '-t', 'boilplate-server:release-check', '.'],
  },
];

type Outcome = { gate: Gate; status: 'passed' | 'failed' | 'skipped'; ms: number; detail: string };

const quick = process.argv.includes('--quick');
const inActions = process.env.GITHUB_ACTIONS === 'true';

function run(gate: Gate): Outcome {
  const reason = gate.unavailable?.() ?? null;

  if (reason) return { gate, status: 'skipped', ms: 0, detail: reason };
  if (quick && gate.heavy) return { gate, status: 'skipped', ms: 0, detail: 'heavy gate, skipped by --quick' };

  const started = Date.now();

  if (inActions) console.log(`::group::${gate.name}`);

  // Captured rather than inherited, so a failing gate's output can be shown next
  // to its name instead of somewhere in a wall of scrollback.
  const result = spawnSync(gate.command, gate.args, { cwd: ROOT, encoding: 'utf8', shell, stdio: 'pipe' });
  const ms = Date.now() - started;
  const output = `${result.stdout}${result.stderr}`.trimEnd();

  if (inActions) {
    console.log(output);
    console.log('::endgroup::');
  }

  return result.status === 0 ? { gate, status: 'passed', ms, detail: '' } : { gate, status: 'failed', ms, detail: output };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const ICON: Record<Outcome['status'], string> = { passed: '✓', failed: '✗', skipped: '–' };

function main(): void {
  console.log(`release — ${GATES.length} gates${quick ? ', --quick (heavy gates skipped)' : ''}\n`);

  const outcomes: Outcome[] = [];

  for (const gate of GATES) {
    process.stdout.write(`  ${gate.name} … `);

    const outcome = run(gate);

    outcomes.push(outcome);
    console.log(outcome.status === 'skipped' ? `skipped (${outcome.detail})` : `${outcome.status} ${seconds(outcome.ms)}`);
  }

  const failed = outcomes.filter((outcome) => outcome.status === 'failed');
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');

  for (const outcome of failed) {
    console.error(`\n${'─'.repeat(72)}\n✗ ${outcome.gate.name} — ${outcome.gate.proves}\n`);
    // The tail, because the cause is almost always at the end and a whole build
    // log is not readable in a summary.
    console.error(outcome.detail.split('\n').slice(-30).join('\n'));
  }

  console.log(`\n${'─'.repeat(72)}`);

  for (const outcome of outcomes) {
    console.log(`  ${ICON[outcome.status]} ${outcome.gate.name.padEnd(18)} ${outcome.status === 'skipped' ? '' : seconds(outcome.ms)}`);
  }

  const summary = `${outcomes.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`;

  if (failed.length > 0) {
    console.error(`\nNot ready to release — ${summary}.`);
    console.error(`Failed: ${failed.map((outcome) => outcome.gate.name).join(', ')}`);
    process.exit(1);
  }

  if (skipped.length > 0) {
    console.log(`\n${summary}. Skipped gates were not run and prove nothing:`);
    for (const outcome of skipped) console.log(`  ${outcome.gate.name} — ${outcome.detail}`);
    console.log('\nRun without --quick, with DATABASE_URL set and Docker available, for a full answer.');
    return;
  }

  console.log(`\nReady to release — ${summary}.`);
}

main();
