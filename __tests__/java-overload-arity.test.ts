/**
 * A Java call to an overloaded method goes to the overload whose parameter
 * count the call's argument count fits. When the resolution settles on an
 * overload of a different arity — the first declared — the argument count
 * alone rules it out, and the call moves to the first declared overload the
 * count does fit (#3040), even when several do: jsoup's
 * `Jsoup.parse(File, String, String, Parser)` is
 * `DataUtil.load(File, String, String, Parser)`, not the 3-parameter `load`
 * above it. A call whose argument count matches no overload keeps what it
 * had.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('Java overload selection by argument count (#3040)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-overload-arity-'));
    const src = path.join(dir, 'src', 'p');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'Parser.java'), `package p;
public class Parser {
}
`);
    fs.writeFileSync(path.join(src, 'App.java'), `package p;

import java.io.File;

public class App {
    String run(File file, String c, String b, Parser p) {
        return Util.load(file, c, b, p);
    }

    String runTwo(File file, String c, String b, Parser p) {
        return Util2.load(file, c, b, p);
    }

    String runFive(File file, String c, String b, Parser p, int extra) {
        return Util.load(file, c, b, p, extra);
    }

    String runFits(File file, String c, String b, Parser p) {
        return Util3.load(file, c, b, p);
    }
}
`);
    // `Util`: a 3-parameter overload first, then two 4-parameter ones — the
    // issue's repro. `Util2`: the two-overload case that already picked by
    // arity. `Util3`: a 4-parameter overload declared FIRST, whose arity the
    // call fits, so the settled answer is kept.
    fs.writeFileSync(path.join(src, 'Util.java'), `package p;

import java.io.File;
import java.nio.file.Path;

public class Util {
    public static String load(File f, String c, String b) { return b; }
    public static String load(File f, String c, String b, Parser p) { return b; }
    public static String load(Path f, String c, String b, Parser p) { return b; }
}
`);
    fs.writeFileSync(path.join(src, 'Util2.java'), `package p;

import java.io.File;

public class Util2 {
    public static String load(File f, String c, String b) { return b; }
    public static String load(File f, String c, String b, Parser p) { return b; }
}
`);
    fs.writeFileSync(path.join(src, 'Util3.java'), `package p;

import java.io.File;

public class Util3 {
    public static String load(File f, String c, String b, Parser p) { return b; }
    public static String load(File f, String c, String b) { return b; }
}
`);
    cg = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The `load` overloads `caller`'s call lands on, by declaration line in Util.java. */
  function loadTargets(caller: string): number[] {
    const fn = cg.getNodesByKind('method').find((n) => n.name === caller)!;
    expect(fn, `${caller} should be in the index`).toBeDefined();
    return cg
      .getOutgoingEdges(fn.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target))
      .filter((n): n is NonNullable<typeof n> => !!n && n.name === 'load')
      .map((n) => n.startLine)
      .sort((a, b) => a - b);
  }

  it("the issue's repro: a 4-argument call with three overloads declared links to a 4-parameter one", () => {
    // Util.java declares the 3-parameter load on line 7, the 4-parameter ones
    // on lines 8 and 9.
    expect(loadTargets('run')).toEqual([8]);
  });

  it('two overloads, one of each arity, still picks the 4-parameter one', () => {
    // Util2.java declares the 3-parameter load on line 6, the 4-parameter one
    // on line 7.
    expect(loadTargets('runTwo')).toEqual([7]);
  });

  it('a call whose argument count matches no overload keeps its previous answer', () => {
    // Five arguments, no overload takes five: the settled overload — the
    // first declared, of the wrong arity — is what the call keeps.
    expect(loadTargets('runFive')).toEqual([7]);
  });

  it('a call whose argument count the first-declared overload fits stays on it', () => {
    // Util3.java declares the 4-parameter load FIRST, on line 6: the settled
    // answer fits and is kept.
    expect(loadTargets('runFits')).toEqual([6]);
  });
});
