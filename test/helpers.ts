import * as fs from 'node:fs';
import * as path from 'node:path';
import { CellInput, DEFAULT_WRITE_OPTIONS, ParsedDocument, WriteOptions, parse, serialize, toCellInputs } from '../src/core';

/** test/fixtures, resolved from out/test at runtime. */
export const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

export function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

export function listFixtures(): string[] {
  return fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.md')).sort();
}

/** Cells as VS Code would hand them back on save when nothing was touched. */
export function untouched(doc: ParsedDocument): CellInput[] {
  // Metadata goes through VS Code as plain JSON; make sure nothing depends on object identity.
  return toCellInputs(doc).map((c) => ({ ...c, meta: JSON.parse(JSON.stringify(c.meta)) as unknown }));
}

export function roundTripBytes(bytes: Uint8Array, opts: WriteOptions = DEFAULT_WRITE_OPTIONS): Uint8Array {
  const doc = parse(decoder.decode(bytes));
  return encoder.encode(serialize(doc.meta, untouched(doc), opts));
}

export function roundTrip(text: string): string {
  const doc = parse(text);
  return serialize(doc.meta, untouched(doc), DEFAULT_WRITE_OPTIONS);
}

export const show = (s: string): string => JSON.stringify(s);
