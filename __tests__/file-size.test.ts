/**
 * The `--max-file-size` / `codegraph.json` `maxFileSize` size unit (issue #369):
 * parsing, formatting, the bounded read it drives, and the loader that puts it
 * in force. Behavior — what gets skipped during indexing — lives in
 * max-file-size.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseFileSize,
  formatFileSize,
  sizeStampHash,
  oversizeStamp,
  readBoundedSource,
  readBoundedSourceSync,
  MAX_SOURCE_FILE_SIZE_BYTES,
} from '../src/file-limits';
import { loadMaxFileSize, resolveMaxFileSize, clearProjectConfigCache } from '../src/project-config';

describe('parseFileSize', () => {
  it('parses human-readable units, case-insensitively and binary', () => {
    expect(parseFileSize('500kb')).toBe(500 * 1024);
    expect(parseFileSize('2mb')).toBe(2 * 1024 * 1024);
    expect(parseFileSize('1gb')).toBe(1024 * 1024 * 1024);
    expect(parseFileSize('2 MB')).toBe(2 * 1024 * 1024);
    expect(parseFileSize('1Gb')).toBe(1024 * 1024 * 1024);
    expect(parseFileSize('8k')).toBe(8 * 1024);
    expect(parseFileSize('1b')).toBe(1);
  });

  it('treats a bare number as bytes', () => {
    expect(parseFileSize('500')).toBe(500);
    expect(parseFileSize(500)).toBe(500);
    expect(parseFileSize(' 2048 ')).toBe(2048);
  });

  it('rounds a fractional size down to whole bytes', () => {
    expect(parseFileSize('1.5mb')).toBe(1.5 * 1024 * 1024);
    expect(parseFileSize('0.5kb')).toBe(512);
  });

  it.each([
    '',
    '   ',
    'mb',
    'abc',
    '1.2.3mb',
    '5pb',
    '1 mb extra',
    '-5',
    '0',
    '0kb',
    '1e3',
  ])('rejects invalid input %j', (raw) => {
    expect(() => parseFileSize(raw)).toThrow(/Invalid file size/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid numeric value %j',
    (raw) => {
      expect(() => parseFileSize(raw)).toThrow(/Invalid file size/);
    }
  );
});

describe('formatFileSize', () => {
  it('renders each unit the parser accepts', () => {
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(500 * 1024)).toBe('500 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatFileSize(1024 ** 3)).toBe('1 GB');
  });

  it('parses back to the same byte count', () => {
    for (const bytes of [512, 1024, 500 * 1024, 2 * 1024 * 1024, 1024 ** 3]) {
      expect(parseFileSize(formatFileSize(bytes))).toBe(bytes);
    }
  });
});

describe('sizeStampHash', () => {
  it('is the sha256 of the oversize stamp the index stores', () => {
    expect(sizeStampHash(2048)).toBe(createHash('sha256').update(oversizeStamp(2048)).digest('hex'));
  });
});

describe('readBoundedSource honours a custom limit', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-size-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a file exactly at the limit and refuses one byte over', async () => {
    const file = path.join(dir, 'a.ts');
    fs.writeFileSync(file, 'x'.repeat(20));
    expect((await readBoundedSource(file, 20)).bytes?.length).toBe(20);
    expect((await readBoundedSource(file, 19)).bytes).toBeNull();
    expect(readBoundedSourceSync(file, 20).bytes?.length).toBe(20);
    expect(readBoundedSourceSync(file, 19).bytes).toBeNull();
  });
});

describe('codegraph.json maxFileSize', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-file-size-config-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(
      path.join(dir, 'codegraph.json'),
      typeof obj === 'string' ? obj : JSON.stringify(obj)
    );

  it('defaults to 1 MB with no codegraph.json', () => {
    expect(loadMaxFileSize(dir)).toBe(MAX_SOURCE_FILE_SIZE_BYTES);
  });

  it('reads a human-readable size and a raw byte count', () => {
    writeConfig({ maxFileSize: '2mb' });
    expect(loadMaxFileSize(dir)).toBe(2 * 1024 * 1024);

    writeConfig({ maxFileSize: 4096 });
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, 'codegraph.json'), future, future);
    expect(loadMaxFileSize(dir)).toBe(4096);
  });

  it('ignores an invalid value and keeps the default', () => {
    writeConfig({ maxFileSize: 'enormous' });
    expect(loadMaxFileSize(dir)).toBe(MAX_SOURCE_FILE_SIZE_BYTES);

    writeConfig({ maxFileSize: true });
    expect(loadMaxFileSize(dir)).toBe(MAX_SOURCE_FILE_SIZE_BYTES);
  });

  it('lets an explicit override win over the config', () => {
    writeConfig({ maxFileSize: '10mb' });
    expect(resolveMaxFileSize(dir, 500 * 1024)).toBe(500 * 1024);
    expect(resolveMaxFileSize(dir)).toBe(10 * 1024 * 1024);
  });
});
