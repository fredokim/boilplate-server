/**
 * Says what changed between two OpenAPI documents, in the words a person needs.
 *
 * The contract compatibility job checks a pull request's spec against each
 * frontend. When one of them fails, the useful question is not "which test" but
 * "what did this pull request change that the frontend was relying on" — and the
 * answer is buried in a three-thousand-line document that nobody will diff by
 * hand at the bottom of a CI log.
 *
 * Paths and schema names only. Descriptions and examples move constantly and
 * break nothing, so listing them would bury the two lines that matter.
 *
 *   node dist/tools/compareSpecs.js <committed.json> <candidate.json>
 */
import { readFileSync } from 'node:fs';

type Schema = { properties?: Record<string, unknown>; required?: string[] };
type Document = {
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, Schema> };
};

function load(path: string): Document {
  return JSON.parse(readFileSync(path, 'utf8')) as Document;
}

function difference(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);

  return {
    added: after.filter((name) => !beforeSet.has(name)),
    removed: before.filter((name) => !afterSet.has(name)),
  };
}

function report(label: string, names: readonly string[]): void {
  if (names.length === 0) return;

  console.log(`${label}:`);
  for (const name of names) console.log(`  ${name}`);
}

function main(): void {
  const [committedPath, candidatePath] = process.argv.slice(2);

  if (!committedPath || !candidatePath) {
    console.error('Usage: compareSpecs <committed.json> <candidate.json>');
    process.exit(2);
  }

  const committed = load(committedPath);
  const candidate = load(candidatePath);

  const paths = difference(Object.keys(committed.paths ?? {}), Object.keys(candidate.paths ?? {}));
  const schemas = difference(
    Object.keys(committed.components?.schemas ?? {}),
    Object.keys(candidate.components?.schemas ?? {}),
  );

  /**
   * A field that stopped being guaranteed is the change most likely to be behind
   * a frontend failure, and the one a reader of the diff is least likely to
   * spot: the property is still there, only its promise is gone.
   */
  const relaxed: string[] = [];
  const tightened: string[] = [];
  const dropped: string[] = [];

  for (const [name, before] of Object.entries(committed.components?.schemas ?? {})) {
    const after = candidate.components?.schemas?.[name];
    if (!after) continue;

    const requiredBefore = new Set(before.required ?? []);
    const requiredAfter = new Set(after.required ?? []);
    const propertiesAfter = new Set(Object.keys(after.properties ?? {}));

    for (const field of Object.keys(before.properties ?? {})) {
      if (!propertiesAfter.has(field)) dropped.push(`${name}.${field}`);
    }
    for (const field of requiredBefore) {
      if (propertiesAfter.has(field) && !requiredAfter.has(field)) relaxed.push(`${name}.${field}`);
    }
    for (const field of requiredAfter) {
      if (!requiredBefore.has(field)) tightened.push(`${name}.${field}`);
    }
  }

  const changed =
    paths.added.length +
    paths.removed.length +
    schemas.added.length +
    schemas.removed.length +
    relaxed.length +
    tightened.length +
    dropped.length;

  if (changed === 0) {
    console.log('This pull request does not change any path or schema the frontends read.');
    return;
  }

  console.log('What this pull request changes in the contract:\n');
  report('Endpoints removed — a client calling one now gets a 404', paths.removed);
  report('Endpoints added — additive, no client breaks on this', paths.added);
  report('Schemas removed', schemas.removed);
  report('Schemas added — additive', schemas.added);
  report('Fields removed — a client validating one now rejects every response', dropped);
  report('Fields no longer guaranteed — a client that requires one now rejects valid responses', relaxed);
  report('Fields newly guaranteed — a client treating one as optional is now stricter than it needs to be', tightened);
}

main();
