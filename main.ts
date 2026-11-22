// mend: one patch tool for every AI edit format.
//
// mend reads a patch in one of four formats -- a unified diff (often with
// wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, or
// text-editor tool calls as JSON -- finds the lines each edit names, and
// applies every edit or none of them, printing what changed or why it failed.
//
// The whole contract is SPEC.md. This file is the CLI: the command line, the
// output and exit codes, safe paths, format detection, the four readers, the
// three-tier line matching, and the all-or-nothing write. Node 22 and its
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An error that ends the run with exit 2 and one line of output. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed, reported as `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The leading spaces and tabs of a line. */
function lead(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

/** A line as one matching tier reads it: exact, trailing whitespace off, or both sides off. */
function norm(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trimEndWs(s) : trimBothWs(s);
}

/** A file's text as its lines, its own line break, and whether it ends with one. */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  eol: boolean;
}

function splitText(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], eol: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let eol = false;
  if (text.endsWith(br)) {
    eol = true;
    lines.pop();
  }
  return { br, lines, eol };
}

function joinText(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.eol ? s.br : '');
}

/** Positions where `old` occurs in `lines` at one tier, from `from` on; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number, from = 0): number[] {
  const pos: number[] = [];
  if (old.length === 0 || old.length > lines.length - from) return pos;
  const want = old.map((l) => norm(l, tier));
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (norm(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (0, 1, 2) at which `old` occurs in `lines`, with its positions, or null when it occurs at none. */
function firstTier(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(lines, old, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a replacement: its text, and whether it is a context line (written as the file's own matched line). */
interface NewLine {
  text: string;
  ctx: boolean;
}

/** One line the edit replaces: its text, and whether it is a context line. */
interface OldLine {
  text: string;
  ctx: boolean;
}

/**
 * The lines that replace the matched lines. A context line is written as the
 * file's own matched line, never the patch's. At tier 2 every other line is
 * re-indented: the leading spaces and tabs of the patch's first old line are
 * replaced by those of the file's first matched line. At tiers 0 and 1 the
 * lines are written as they are.
 */
function renderNew(nLines: NewLine[], oLines: OldLine[], fileLines: string[], at: number, tier: number): string[] {
  const oCtx: number[] = [];
  oLines.forEach((l, i) => {
    if (l.ctx) oCtx.push(i);
  });
  const f = tier === 2 && oLines.length > 0 ? lead(fileLines[at]!) : '';
  const p = tier === 2 && oLines.length > 0 ? lead(oLines[0]!.text) : '';
  let k = 0;
  return nLines.map((l) => {
    if (l.ctx) {
      const out = fileLines[at + oCtx[k]!]!;
      k += 1;
      return out;
    }
    if (tier === 2 && l.text !== '' && !onlyWs(l.text) && l.text.startsWith(p)) return f + l.text.slice(p.length);
    return l.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly disk = new Map<string, { exists: boolean; content: string | null }>();
  readonly now = new Map<string, string | null>();
  /** Where a path's current content was moved from, by its move edits. */
  readonly origin = new Map<string, string>();

  private info(p: string): { exists: boolean; content: string | null } {
    let d = this.disk.get(p);
    if (d === undefined) {
      d = { exists: false, content: null };
      try {
        const st = statSync(p);
        d.exists = true;
        if (st.isFile()) d.content = readFileSync(p, 'utf8');
      } catch {
        d.exists = false;
        d.content = null;
      }
      this.disk.set(p, d);
    }
    return d;
  }

  /** The content of a regular file on disk, or null. */
  original(p: string): string | null {
    return this.info(p).content;
  }

  /** The path's content as the edits leave it, or null when it is gone. */
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** True when the path is present as the edits leave it: a file in the tree, or anything on disk. */
  present(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    return this.info(p).exists;
  }

  set(p: string, text: string): void {
    this.now.set(p, text);
  }

  create(p: string, text: string): void {
    this.now.set(p, text);
    this.origin.delete(p);
  }

  remove(p: string): void {
    this.now.set(p, null);
    this.origin.delete(p);
  }

  move(from: string, to: string, text: string): void {
    this.now.set(to, text);
    this.now.set(from, null);
    this.origin.set(to, this.origin.get(from) ?? from);
    this.origin.delete(from);
  }
}

/** One edit: a function of the tree that throws Fail when it cannot apply. */
type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

/** One body line of a hunk: a context line, an old line, a new line, or a `\` line. */
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
}

interface Hunk {
  /** The old start line number, from `@@ -A[,B] +C[,D] @@`. */
  a: number;
  entries: BodyEntry[];
  /** True when a `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFFGIT_RE = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, spaces removed, `a/` or `b/` off, `/dev/null` as no file. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t === '/dev/null' ? null : t;
}

/** One hunk and the index of the first line after its body. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!)!;
  const a = Number(m[1]);
  const entries: BodyEntry[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') {
      entries.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      entries.push({ kind: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      entries.push({ kind: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      entries.push({ kind: 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      entries.push({ kind: 'back', text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (entries.length > 0) {
    const last = entries[entries.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') entries.pop();
    else break;
  }
  let noNewline = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k]!;
    if (e.kind === 'ctx' || e.kind === 'new') {
      noNewline = entries[k + 1]?.kind === 'back';
      break;
    }
  }
  return { hunk: { a, entries, noNewline }, next: j };
}

function blankSection(): Section {
  return {
    diffOld: null,
    diffNew: null,
    minusPath: null,
    plusPath: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let phase: 'none' | 'header' | 'hunks' = 'none';
  let i = 0;
  const fail = (line: number): never => {
    throw new Exit2(`error: parse ${line}`);
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFFGIT_RE.exec(l);
      if (m === null) fail(i + 1);
      cur = blankSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      phase = 'header';
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) fail(i + 1);
      if (HUNK_RE.exec(l) === null) fail(i + 1);
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      phase = 'hunks';
      i = r.next;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (phase === 'header' && cur !== null && !cur.hasPair) {
          cur.minusPath = headerPath(l);
          cur.plusPath = headerPath(next);
          cur.hasPair = true;
          i += 2;
          continue;
        }
        cur = blankSection();
        cur.minusPath = headerPath(l);
        cur.plusPath = headerPath(next);
        cur.hasPair = true;
        sections.push(cur);
        phase = 'header';
        i += 2;
        continue;
      }
      if (phase === 'header') fail(i + 2);
      i++;
      continue;
    }
    if (phase === 'header' && cur !== null) {
      if (l.startsWith('+++ ') && !cur.hasPair && cur.plusPath === null) {
        cur.plusPath = headerPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ') && cur.renameFrom === null) {
        cur.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ') && cur.renameTo === null) {
        cur.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** True when a `\` line follows the last `+` line of a section's hunks. */
function lastPlusNoNewline(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const entries = hunks[hi]!.entries;
    for (let k = entries.length - 1; k >= 0; k--) {
      if (entries[k]!.kind === 'new') return entries[k + 1]?.kind === 'back';
    }
  }
  return false;
}

function hunkOldNew(h: Hunk): { o: OldLine[]; n: NewLine[] } {
  const o: OldLine[] = [];
  const n: NewLine[] = [];
  for (const e of h.entries) {
    if (e.kind === 'ctx') {
      o.push({ text: e.text, ctx: true });
      n.push({ text: e.text, ctx: true });
    } else if (e.kind === 'old') o.push({ text: e.text, ctx: false });
    else if (e.kind === 'new') n.push({ text: e.text, ctx: false });
  }
  return { o, n };
}

/** One hunk applied to a file: its old lines are found at the first tier that has them, nearest to where its header says. */
function applyHunk(state: FileState, h: Hunk, d: number, strict: boolean, failPath: string): FileState {
  const lines = state.lines;
  const { o, n } = hunkOldNew(h);
  const oLines = o.map((e) => e.text);
  if (oLines.length === 0) {
    const at = Math.min(Math.max(h.a + d, 0), lines.length);
    const next = lines.slice();
    next.splice(at, 0, ...n.map((e) => e.text));
    return { br: state.br, lines: next, eol: at === lines.length ? !h.noNewline : state.eol };
  }
  const found = firstTier(lines, oLines, strict);
  if (found === null) throw new Fail('no-match', failPath);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const made = renderNew(n, o, lines, best, found.tier);
  const next = lines.slice(0, best).concat(made, lines.slice(best + oLines.length));
  return { br: state.br, lines: next, eol: best + oLines.length === lines.length ? !h.noNewline : state.eol };
}

/** A section's hunks applied in order, each to the result of the ones before it. */
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, failPath: string): FileState {
  let cur = state;
  let d = 0;
  for (const h of hunks) {
    cur = applyHunk(cur, h, d, strict, failPath);
    const { o, n } = hunkOldNew(h);
    d += n.length - o.length;
  }
  return cur;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null;
    let newP: string | null;
    if (sec.hasPair) {
      oldP = sec.minusPath;
      newP = sec.plusPath;
    } else if (sec.renameFrom !== null || sec.renameTo !== null) {
      oldP = sec.renameFrom ?? sec.diffOld;
      newP = sec.renameTo ?? sec.diffNew;
    } else {
      oldP = sec.diffOld;
      newP = sec.diffNew;
    }
    if (oldP === null && newP === null) return;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.newFile || oldP === null;
    const isDelete = !isCreate && (sec.deletedFile || newP === null);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    if (isCreate) {
      const p = newP!;
      if (tree.present(p)) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const e of h.entries) if (e.kind === 'new') plus.push(e.text);
      }
      const noNl = lastPlusNoNewline(sec.hunks);
      tree.create(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.remove(p);
      return;
    }
    if (isMove) {
      const from = oldP!;
      const to = newP!;
      const cur = tree.get(from);
      if (cur === null) throw new Fail('missing', from);
      if (tree.present(to)) throw new Fail('exists', to);
      const out = applyHunks(splitText(cur), sec.hunks, strict, from);
      tree.move(from, to, joinText(out));
      return;
    }
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const out = applyHunks(splitText(cur), sec.hunks, strict, p);
    tree.set(p, joinText(out));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const trimmed = t.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.present(path)) throw new Fail('exists', path);
      tree.create(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const st = splitText(cur);
    const found = firstTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const o: OldLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: false }));
    const made = renderNew(n, o, st.lines, at, found.tier);
    const lines = st.lines.slice(0, at).concat(made, st.lines.slice(at + oldLines.length));
    tree.set(path, joinText({ br: st.br, lines, eol: st.eol }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  entries: BodyEntry[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.trim() === '*** End Patch') throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind = l.startsWith('*** Add') ? 'add' : l.startsWith('*** Delete') ? 'delete' : 'update';
      const path = l.slice(l.indexOf(': ') + 2).trim();
      const body: string[] = [];
      let j = i + 1;
      while (j < last) {
        const s = lines[j]!;
        if (s.trim() === '*** End Patch') break;
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
        body.push(s);
        j++;
      }
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      edits.push(v4aEdit(kind, path, body, i + 1, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aEdit(kind: string, path: string, body: string[], headerLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < body.length; k++) {
      const l = body[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${headerLine + 1 + k}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.present(path)) throw new Fail('exists', path);
      tree.create(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (body.length > 0) throw new Exit2(`error: parse ${headerLine + 1}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.remove(path);
    };
  }
  let moveTo: string | null = null;
  let start = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    start = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (let k = start; k < body.length; k++) {
    const l = body[k]!;
    const lineNo = headerLine + 1 + k;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, entries: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, entries: [], eof: false };
          chunks.push(cur);
        } else throw new Exit2(`error: parse ${lineNo}`);
      }
      if (l === '') cur.entries.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') cur.entries.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.entries.push({ kind: 'old', text: l.slice(1) });
      else cur.entries.push({ kind: 'new', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.present(moveTo)) throw new Fail('exists', moveTo);
    let state = splitText(curText);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = firstTier(state.lines, [chunk.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const o: OldLine[] = [];
      const n: NewLine[] = [];
      for (const e of chunk.entries) {
        if (e.kind === 'ctx') {
          o.push({ text: e.text, ctx: true });
          n.push({ text: e.text, ctx: true });
        } else if (e.kind === 'old') o.push({ text: e.text, ctx: false });
        else if (e.kind === 'new') n.push({ text: e.text, ctx: false });
      }
      const oLines = o.map((e) => e.text);
      if (oLines.length === 0) {
        const at = chunk.eof ? state.lines.length : cursor;
        const next = state.lines.slice();
        next.splice(at, 0, ...n.map((e) => e.text));
        state = { br: state.br, lines: next, eol: state.eol };
        cursor = at + n.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top; t++) {
        const pos = occurrences(state.lines, oLines, t, cursor).filter(
          (p) => !chunk.eof || p + oLines.length === state.lines.length,
        );
        if (pos.length > 0) {
          found = { tier: t, pos: pos[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const made = renderNew(n, o, state.lines, found.pos, found.tier);
      const next = state.lines.slice(0, found.pos).concat(made, state.lines.slice(found.pos + oLines.length));
      state = { br: state.br, lines: next, eol: state.eol };
      cursor = found.pos + made.length;
    }
    const out = joinText(state);
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.set(path, out);
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.present(p)) throw new Fail('exists', p);
      tree.create(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const st = splitText(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      const lines = st.lines.slice();
      lines.splice(line, 0, ...add);
      tree.set(p, joinText({ br: st.br, lines, eol: st.eol }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
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
    if (edits.length === 0) throw new Exit2('error: parse 1');
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
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4) and the run
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

function readPatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  if (kind === 'v4a') return parseV4a(lines, strict);
  if (kind === 'json') return parseJson(text, lines);
  throw new Exit2('error: format');
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
    edits = readPatch(kind, text, lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeOrigin = new Map(tree.origin);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.origin.clear();
      for (const [k, v] of beforeOrigin) tree.origin.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const sorted = [...tree.now.keys()].sort(byteOrder);
  // A move prints as one `R <old> -> <new>` line, sorting by <new>, when the
  // old path existed before the patch and does not after it, and the new path
  // did not exist before it and does after it.
  const rTo = new Map<string, string>();
  for (const p of sorted) {
    const was = tree.original(p);
    const is = tree.now.get(p)!;
    if (was === null && is !== null) {
      const o = tree.origin.get(p);
      if (o !== undefined && o !== p && tree.original(o) !== null && tree.now.get(o) === null) rTo.set(p, o);
    }
  }
  const rFrom = new Set<string>(rTo.values());
  const rows: { line: string; del: string | null; write: { path: string; text: string } | null }[] = [];
  for (const p of sorted) {
    const was = tree.original(p);
    const is = tree.now.get(p)!;
    if (was === is) continue;
    if (rTo.has(p)) {
      rows.push({ line: `R ${rTo.get(p)} -> ${p}`, del: rTo.get(p)!, write: { path: p, text: is } });
      continue;
    }
    if (rFrom.has(p)) continue;
    if (was === null) rows.push({ line: `A ${p}`, del: null, write: { path: p, text: is } });
    else if (is === null) rows.push({ line: `D ${p}`, del: p, write: null });
    else rows.push({ line: `M ${p}`, del: null, write: { path: p, text: is } });
  }
  if (!check) {
    for (const r of rows) if (r.del !== null) rmSync(r.del, { force: true });
    for (const r of rows) {
      if (r.write === null) continue;
      mkdirSync(dirname(r.write.path), { recursive: true });
      writeFileSync(r.write.path, r.write.text);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
