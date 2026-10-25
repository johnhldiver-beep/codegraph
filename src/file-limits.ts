import { createHash } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

/**
 * Largest source file CodeGraph parses by default. Generated bundles, minified
 * sources, and dependency archives above this limit provide no useful symbols;
 * 1 MB covers essentially all hand-written source. A project can lower or raise
 * it with `maxFileSize` in `codegraph.json`, or for one run with
 * `--max-file-size`; resolution keeps this as its ceiling regardless (#1288).
 */
export const MAX_SOURCE_FILE_SIZE_BYTES = 1024 * 1024;

/** Multipliers for {@link parseFileSize}; binary (1 kb = 1024 bytes). */
const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

/**
 * Parse a human-readable file size into bytes: `500kb`, `2mb`, `1gb`, `1.5mb`,
 * or a bare number (bytes). Units are case-insensitive and binary (1 kb = 1024
 * bytes). Throws with the offending value for anything that is not a positive
 * size — the CLI turns that into an error, config loading into a warning.
 */
export function parseFileSize(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input) || input <= 0) {
      throw new Error(`Invalid file size "${input}" — expected a positive number of bytes`);
    }
    return input;
  }

  const raw = String(input).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(raw);
  const amount = match ? Number(match[1]) : Number.NaN;
  const unit = match ? match[2] ?? '' : '';
  if (!match || !Number.isFinite(amount) || amount <= 0 || !(unit === '' || unit in SIZE_UNITS)) {
    throw new Error(
      `Invalid file size "${input}" — expected a size like 500kb, 2mb, or 1gb (a bare number means bytes)`
    );
  }
  const factor = unit === '' ? 1 : SIZE_UNITS[unit]!;
  const bytes = Math.floor(amount * factor);
  if (bytes <= 0) throw new Error(`Invalid file size "${input}" — expected a positive number of bytes`);
  return bytes;
}

/** Render a byte count the way {@link parseFileSize} accepts it back. */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Number((bytes / 1024 ** 3).toFixed(2))} GB`;
  if (bytes >= 1024 ** 2) return `${Number((bytes / 1024 ** 2).toFixed(2))} MB`;
  if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(2))} KB`;
  return `${bytes} B`;
}

/**
 * What stands in for the content of a file over the indexing size limit. Such a
 * file is never parsed, so its bytes are never needed — reading them only to hash
 * and discard cost multi-GB RSS spikes on committed video/blob fixtures and could
 * fail outright with `Invalid string length` (#1910). The stamp is a function
 * of size alone: change detection compares it to the stored hash, so a
 * same-size rewrite of an oversize file is not a change (nothing about it is
 * indexed), while crossing the limit in either direction is.
 */
export function oversizeStamp(size: number): string {
  return `codegraph:oversize:${size}`;
}

/**
 * The sha256 hex the index stores for a file skipped as oversize: the stamp
 * alone. A reader that wants "is this file still what was indexed?" can compare
 * this cheaply, without knowing which limit the index was built with — the
 * stamp is threshold-free on purpose, so a later config change does not turn
 * every skipped file into false drift.
 */
export function sizeStampHash(size: number): string {
  return createHash('sha256').update(oversizeStamp(size)).digest('hex');
}

/** A source file's stats, and its bytes when they are within the limit (null = oversize). */
export interface BoundedSource {
  stats: fs.Stats;
  bytes: Buffer | null;
}

const READ_CHUNK_BYTES = 64 * 1024;

function assertRegularFile(stats: fs.Stats): void {
  if (!stats.isFile()) throw new Error('Source path is not a regular file');
}

/**
 * Read a source file without ever holding more than the limit plus one byte.
 * A stat before the read is not enough: the file can grow between the stat
 * and the read (a log, a download, a build output being written), so the
 * descriptor is re-checked after opening and the read itself stops one byte
 * past the limit. Returns `bytes: null` for an oversize file. `maxBytes`
 * defaults to the built-in limit; indexing passes the project's resolved one.
 */
export async function readBoundedSource(
  file: string,
  maxBytes: number = MAX_SOURCE_FILE_SIZE_BYTES
): Promise<BoundedSource> {
  const initial = await fsp.stat(file);
  assertRegularFile(initial);
  if (initial.size > maxBytes) return { stats: initial, bytes: null };
  const handle = await fsp.open(file, 'r');
  try {
    let stats = await handle.stat();
    assertRegularFile(stats);
    if (stats.size > maxBytes) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = await handle.stat();
    if (size > maxBytes || stats.size > maxBytes) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

/** Synchronous {@link readBoundedSource}. */
export function readBoundedSourceSync(
  file: string,
  maxBytes: number = MAX_SOURCE_FILE_SIZE_BYTES
): BoundedSource {
  const initial = fs.statSync(file);
  assertRegularFile(initial);
  if (initial.size > maxBytes) return { stats: initial, bytes: null };
  const fd = fs.openSync(file, 'r');
  try {
    let stats = fs.fstatSync(fd);
    assertRegularFile(stats);
    if (stats.size > maxBytes) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - size));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = fs.fstatSync(fd);
    if (size > maxBytes || stats.size > maxBytes) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    fs.closeSync(fd);
  }
}
