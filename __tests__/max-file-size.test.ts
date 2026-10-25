/**
 * `--max-file-size` / `codegraph.json` `maxFileSize` (issue #369): files over
 * the limit are skipped at indexing time (recorded, never parsed), files under
 * it index normally, and the flag overrides the config for one run — including
 * a limit ABOVE the built-in 1 MB ceiling.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { hashContent } from '../src/extraction';
import { oversizeStamp, parseFileSize } from '../src/file-limits';
import { clearProjectConfigCache } from '../src/project-config';

describe('indexing honours a configured size limit (issue #369)', () => {
  let dir: string;
  afterEach(() => {
    clearProjectConfigCache();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const bigModule = (bytes: number, marker: string): string => {
    const lines = [`export const ${marker} = 1;\n`];
    let size = lines[0]!.length;
    for (let i = 0; size < bytes; i++) {
      const line = `export const filler${i} = ${i};\n`;
      lines.push(line);
      size += line.length;
    }
    return lines.join('');
  };

  const functionNames = (cg: CodeGraph) => cg.getNodesByKind('function').map((n) => n.name);
  const symbolsInFile = (cg: CodeGraph, file: string) =>
    cg.getNodesInFile(file).filter((n) => n.kind !== 'file').map((n) => n.name);

  it('skips a file over codegraph.json maxFileSize and indexes one under it', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-file-'));
    fs.writeFileSync(path.join(dir, 'small.ts'), 'export function smallThing() { return 1; }\n');
    const big = bigModule(3 * 1024, 'bigThing');
    fs.writeFileSync(path.join(dir, 'big.ts'), big);
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ maxFileSize: '2kb' }));
    clearProjectConfigCache();

    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(functionNames(cg)).toContain('smallThing');
      expect(symbolsInFile(cg, 'big.ts')).toEqual([]);
      // The skipped file is still tracked, hashed as its size stamp, so change
      // detection can tell "unchanged oversize file" from "gone or resized".
      const rec = cg.getFiles().find((f) => f.path === 'big.ts')!;
      expect(rec.contentHash).toBe(hashContent(oversizeStamp(Buffer.byteLength(big))));
      // Change detection reads under the same configured limit — no phantom edit.
      expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
    } finally {
      cg.close();
    }
  });

  it('lets the init/IndexOptions limit override a larger maxFileSize', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-file-flag-'));
    fs.writeFileSync(path.join(dir, 'small.ts'), 'export function kept() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'big.ts'), bigModule(3 * 1024, 'dropped'));
    // The config would index it; the explicit limit must win for this run.
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ maxFileSize: '10mb' }));
    clearProjectConfigCache();

    const cg = await CodeGraph.init(dir, { index: true, maxFileSize: parseFileSize('1kb') });
    try {
      expect(functionNames(cg)).toContain('kept');
      expect(symbolsInFile(cg, 'big.ts')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('indexes a file above the built-in 1 MB default when the limit is raised', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-max-file-raised-'));
    const big = bigModule(1.2 * 1024 * 1024, 'largeButFine');
    fs.writeFileSync(path.join(dir, 'large.ts'), big);

    // Default first: the same file is skipped.
    const before = await CodeGraph.init(dir, { index: true });
    try {
      expect(symbolsInFile(before, 'large.ts')).toEqual([]);
    } finally {
      before.close();
    }

    // Re-index with the limit raised: now the bytes are read and parsed.
    const cg = await CodeGraph.openSync(dir);
    try {
      await cg.indexAll({ maxFileSize: parseFileSize('2mb') });
      expect(symbolsInFile(cg, 'large.ts')).toContain('largeButFine');
    } finally {
      cg.close();
    }
  });
});
