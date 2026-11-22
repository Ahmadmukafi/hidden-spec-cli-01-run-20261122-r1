// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** One line of N: its text, whether it is a context line, and its index in O. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

const leadWs = (s: string): string => {
  let k = 0;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k += 1;
  return s.slice(0, k);
};

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Positions where O occurs in F at one tier (occurrences may overlap). */
function occurrencesAt(O: string[], F: string[], tier: number): number[] {
  const out: number[] = [];
  const oN = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= F.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (normLine(F[i + j]!, tier) !== oN[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in F, with every occurrence there (SPEC.md section 5). */
function findTier(O: string[], F: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(O, F, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** N with context lines as the file's own matched lines and tier-2 re-indentation. */
function buildReplacement(O: string[], N: NLine[], F: string[], at: number, tier: number): string[] {
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  const Fl = F.length > at ? leadWs(F[at]!) : '';
  const out: string[] = [];
  for (const nl of N) {
    if (nl.ctx) { out.push(F[at + nl.oIdx]!); continue; }
    if (tier === 2 && nl.text !== '' && !/^[ \t]*$/.test(nl.text) && nl.text.startsWith(P)) out.push(Fl + nl.text.slice(P.length));
    else out.push(nl.text);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One body line of a unified hunk or a V4A chunk. `empty` marks a truly empty patch line. */
interface BodyItem {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  empty: boolean;
}

interface Hunk {
  A: number;
  items: BodyItem[];
  O: string[];
  N: NLine[];
  noFinal: boolean;
}

/** O, N and the no-final-break flag of a hunk or chunk body. */
function makeHunk(items: BodyItem[]): { O: string[]; N: NLine[]; noFinal: boolean } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const it of items) {
    if (it.kind === ' ') { N.push({ text: it.text, ctx: true, oIdx: O.length }); O.push(it.text); }
    else if (it.kind === '-') O.push(it.text);
    else if (it.kind === '+') N.push({ text: it.text, ctx: false, oIdx: -1 });
  }
  let noFinal = false;
  for (let k = items.length - 1; k >= 0; k -= 1) {
    const it = items[k]!;
    if (it.kind === ' ' || it.kind === '+') {
      noFinal = k + 1 < items.length && items[k + 1]!.kind === '\\';
      break;
    }
  }
  return { O, N, noFinal };
}

interface UniSection {
  diffX: string | null;
  diffY: string | null;
  pair: { old: string | null; new: string | null } | null;
  rename: { from: string | null; to: string | null } | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `---`/`+++`/`rename` path: up to the first tab, spaces removed, /dev/null is no file, a/ or b/ stripped. */
function uniPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One hunk starting at lines[at]; returns it and the index after its body. */
function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[at]!);
  if (m === null) throw new Exit2(`error: parse ${at + 1}`);
  const A = Number(m[1]);
  const items: BodyItem[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') { items.push({ kind: ' ', text: '', empty: true }); j += 1; continue; }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      items.push({ kind: c as BodyItem['kind'], text: l.slice(1), empty: false });
      j += 1;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === ' ' && last.text === '' && last.empty) items.pop();
    else break;
  }
  const { O, N, noFinal } = makeHunk(items);
  return { hunk: { A, items, O, N, noFinal }, next: j };
}

/** The section's edit (SPEC.md section 6), resolved from its header. */
function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  let oldPath: string | null;
  let newPath: string | null;
  if (s.pair !== null) { oldPath = s.pair.old; newPath = s.pair.new; }
  else if (s.rename !== null) {
    oldPath = s.rename.from !== null ? s.rename.from : s.diffX;
    newPath = s.rename.to !== null ? s.rename.to : s.diffY;
  } else { oldPath = s.diffX; newPath = s.diffY; }
  let kind: 'create' | 'delete' | 'move' | 'change';
  if (oldPath === null || s.newFile) kind = 'create';
  else if (newPath === null || s.deletedFile) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  return (tree) => {
    if (kind === 'create') {
      if (newPath === null) return;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out: string[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === '+') out.push(it.text);
      let noFinal = false;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        const h = s.hunks[k]!;
        if (h.items.some((it) => it.kind === '+')) { noFinal = h.noFinal; break; }
      }
      tree.now.set(newPath, out.length === 0 ? '' : out.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      if (oldPath === null) return;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const oldP = oldPath!;
    const newP = kind === 'move' ? newPath! : oldPath!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (kind === 'move' && !safe(newP)) throw new Fail('unsafe', newP);
    const content = tree.get(oldP);
    if (content === null) throw new Fail('missing', oldP);
    if (kind === 'move' && tree.get(newP) !== null) throw new Fail('exists', newP);
    const cur = splitFile(content);
    let d = 0;
    for (const h of s.hunks) {
      if (h.O.length === 0) {
        const at = Math.min(Math.max(h.A + d, 0), cur.lines.length);
        const atEnd = at === cur.lines.length;
        const ins = h.N.map((nl) => nl.text);
        cur.lines.splice(at, 0, ...ins);
        if (atEnd) cur.final = !h.noFinal;
        d += h.N.length;
      } else {
        const found = findTier(h.O, cur.lines, strict);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.A - 1 + d;
        let best = found.pos[0]!;
        let bestD = Math.abs(best - target);
        for (const p of found.pos) {
          const dd = Math.abs(p - target);
          if (dd < bestD) { best = p; bestD = dd; }
        }
        const atEnd = best + h.O.length === cur.lines.length;
        const rep = buildReplacement(h.O, h.N, cur.lines, best, found.tier);
        cur.lines.splice(best, h.O.length, ...rep);
        if (atEnd) cur.final = !h.noFinal;
        d += h.N.length - h.O.length;
      }
    }
    const out = joinFile(cur.lines, cur.br, cur.final);
    if (kind === 'move') {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/** Read a patch as unified diffs (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let cur: UniSection | null = null;
  let inHeader = false;
  const blankSection = (): UniSection => ({ diffX: null, diffY: null, pair: null, rename: null, newFile: false, deletedFile: false, hunks: [] });
  const diffGit = (line: string): [string, string] | null => {
    const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
    return m ? [m[1]!, m[2]!] : null;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = diffGit(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffX = g[0];
      s.diffY = g[1];
      sections.push(s);
      cur = s;
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const pair = { old: uniPath(line.slice(4)), new: uniPath(lines[i + 1]!.slice(4)) };
      if (cur !== null && inHeader) cur.pair = pair;
      else {
        const s = blankSection();
        s.pair = pair;
        sections.push(s);
        cur = s;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        inHeader = false;
        i = h.next;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.rename === null) cur.rename = { from: null, to: null };
        cur.rename.from = uniPath(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) {
        if (cur.rename === null) cur.rename = { from: null, to: null };
        cur.rename.to = uniPath(line.slice('rename to '.length));
      } else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const cur = splitFile(content);
    const found = findTier(oldLines, cur.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length !== 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const rep = buildReplacement(oldLines, newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })), cur.lines, at, found.tier);
    cur.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile(cur.lines, cur.br, cur.final));
  };
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
  O: string[];
  N: NLine[];
}

/** One V4A Add File section. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

/** One V4A Delete File section. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section (SPEC.md section 8). */
function v4aUpdateEdit(path: string, body: string[], bodyStart: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let started = false;
  const lineNo = (k: number): number => bodyStart + k + 1;
  for (; idx < body.length; idx += 1) {
    const bl = body[idx]!;
    if (bl.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: bl.slice(2).trim(), eof: false, items: [], O: [], N: [] };
      started = true;
    } else if (bl === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(idx)}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${lineNo(idx)}`);
        cur = { anchor: null, eof: false, items: [], O: [], N: [] };
        started = true;
      }
      cur.items.push({ kind: (bl === '' ? ' ' : bl[0]!) as BodyItem['kind'], text: bl === '' ? '' : bl.slice(1), empty: bl === '' });
    } else {
      throw new Exit2(`error: parse ${lineNo(idx)}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${bodyStart}`);
  for (const ch of chunks) {
    const { O, N } = makeHunk(ch.items);
    ch.O = O;
    ch.N = N;
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const curF = splitFile(content);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundAt = -1;
        for (const t of tiers) {
          for (let p = cursor; p < curF.lines.length; p += 1) {
            if (normLine(curF.lines[p]!, t) === normLine(ch.anchor!, t)) { foundAt = p; break; }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? curF.lines.length : cursor;
        const ins = ch.N.map((nl) => nl.text);
        curF.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        let tier = -1;
        let occ: number[] = [];
        for (const t of tiers) {
          const all = occurrencesAt(ch.O, curF.lines, t).filter((p) => p >= cursor);
          if (all.length > 0) { tier = t; occ = all; break; }
        }
        if (tier < 0) throw new Fail('no-match', path);
        let at = -1;
        if (ch.eof) {
          for (const p of occ) {
            if (p + ch.O.length === curF.lines.length) { at = p; break; }
          }
          if (at < 0) throw new Fail('no-match', path);
        } else {
          at = occ[0]!;
        }
        const rep = buildReplacement(ch.O, ch.N, curF.lines, at, tier);
        curF.lines.splice(at, ch.O.length, ...rep);
        cursor = at + rep.length;
      }
    }
    const out = joinFile(curF.lines, curF.br, curF.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read a patch as a V4A patch (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (!isStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isStart(lines[j]!)) j += 1;
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    const body = lines.slice(i + 1, end);
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k += 1) {
        const bl = body[k]!;
        if (bl === '') fileLines.push('');
        else if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      if (body.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      const path = line.slice('*** Update File: '.length).trim();
      edits.push(v4aUpdateEdit(path, body, i + 1, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()]
    .filter((p) => tree.original(p) !== tree.now.get(p))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      suppressed.add(o);
      suppressed.add(n);
    }
  }
  for (const p of changed) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const linesOut = rows.map((r) => r.line);
  if (!check) {
    for (const p of changed) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...linesOut, `ok: ${linesOut.length} ${linesOut.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
