/**
 * `codegraph init --max-file-size` (issue #369): the flag is parsed up front,
 * an invalid size is a clean error, and a skipped file is reported rather than
 * silently missing from the index.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('codegraph init/index --max-file-size (issue #369)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips a file over the flag value and says so', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-max-file-'));
    fs.writeFileSync(path.join(dir, 'small.ts'), 'export function kept() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'big.ts'), 'export const x = 1;\n'.repeat(200));

    const r = run(dir, ['init', dir, '--max-file-size', '1kb', '--yes']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Skipped 1 file(s) over the size limit (1 KB)');

    const cg = CodeGraph.openSync(dir);
    try {
      expect(cg.getNodesByKind('function').map((n) => n.name)).toContain('kept');
      expect(cg.getNodesInFile('big.ts').filter((n) => n.kind !== 'file')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('rejects a malformed size with a clear error and indexes nothing', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-max-file-bad-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');

    const r = run(dir, ['init', dir, '--max-file-size', 'huge', '--yes']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('Invalid file size "huge"');
    expect(r.out).toContain('500kb, 2mb, or 1gb');
    expect(fs.existsSync(path.join(dir, '.codegraph'))).toBe(false);
  });
});
