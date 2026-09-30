/**
 * Classify a launcher-drift `stale` delta as behavioural or not (APP-261).
 *
 * WHY THIS EXISTS
 *
 * `detect-launcher-drift.mjs` rated *any* content change to a versioned
 * launcher file `stale`/`high` and routed it to the CEO, reporting blob hashes
 * and nothing else. Twice that escalated a change with no behavioural effect:
 *
 *   APP-226  a 5-line `collateralNote` advice string, headlined "Production is
 *            not running that fix." The CEO read the diff by hand to find the
 *            claim was wrong. Corrected `high` -> `low` after a board approval.
 *   APP-260  `config/github-apps.yaml`, comment-only — stripping comments from
 *            both revisions yields byte-identical files. The added text was
 *            APP-251/APP-92 documentation arguing *against* widening reach.
 *
 * The cost of that miss runs the wrong way. An operator who sees documentation
 * edits escalated as `high` learns to discount the check, and discounting the
 * check is exactly how the APP-72 blind spot — a merged worktree-prune backstop
 * sitting inert in production for days — comes back.
 *
 * FAIL TOWARD `high`, ALWAYS
 *
 * A false `low` reintroduces that blind spot. A false `high` costs one read.
 * So every uncertainty here resolves to `high`: an unknown file type, an
 * unparseable diff, a lexer that loses its place, a mixed change, a diff that
 * claims no changed lines while the digests differ. `low` is returned only when
 * TWO independent checks agree, and it is never returned for anything other
 * than a `stale` finding.
 *
 * THE TWO CHECKS, AND WHY IT TAKES TWO
 *
 * 1. Whole-file strip-and-compare. Both revisions are scanned from byte 0 with
 *    a string-aware comment scanner and compared. Scanning whole files rather
 *    than diff hunks is what makes block comments and multi-line strings
 *    tractable at all: a hunk gives no way to know whether its first line is
 *    already inside a block-comment run that opened above it.
 * 2. Every added and removed line, trimmed, is blank or starts with a comment
 *    marker for the language.
 *
 * Check 1 alone is not enough because a comment scanner can be wrong. A `/` in
 * code position is a regex literal or a division and this scanner does not try
 * to tell them apart; a regex holding a quote character can desync it. Check 2
 * is the backstop: a mis-scanned line has real code on it, so it does not start
 * with `//`, and the verdict falls through to `high`.
 *
 * Check 2 alone is not enough because a line can look like a comment and not be
 * one. `// not a comment` added inside a JS template literal changes what the
 * program prints; the prefix test passes and check 1 catches it.
 *
 * STRING LITERALS ARE NOT FREE — AND THAT IS A DELIBERATE NARROWING
 *
 * APP-261's acceptance text groups "comment lines, string literals, or
 * whitespace" into one non-behavioural class. This module does not, by default.
 * A changed string literal is a changed program value, and this repository
 * contains the counter-example: the repo allowlists and the
 * `deliberately_excluded` entries that keep agents off `release-platform` and
 * `InvTrack` are string data. Swapping one string there is a containment change
 * that a strings-are-free rule would route as a note — a false `low` of exactly
 * the kind the issue's own asymmetry argument forbids.
 *
 * So `strings_only` is reported as its own verdict and labelled in the report —
 * the reader learns "the only changed code is string text" without opening a
 * second investigation, which is the actual cost APP-226 paid — but it keeps
 * `high`. `treatStringsAsNonBehavioural: true` flips it to `low` for a caller
 * that decides otherwise; nothing in this repo passes it.
 *
 * NEVER SUPPRESSES A FINDING
 *
 * This module returns a severity and a label. It cannot drop a finding, and it
 * is consulted for `stale` only. `tampered`, `missing` and `manifest_mismatch`
 * stay `critical` whatever the delta contains: an unexplained hand-edit to the
 * credential-bearing launcher tree is critical because it is unexplained, not
 * because of which bytes it touched.
 */

/** Default cap on diff lines carried into the report, per finding. */
export const DEFAULT_DIFF_LINE_LIMIT = 200;

/**
 * Comment grammar by file extension. A file type that is not in here gets
 * `unparseable` and stays `high` — silently assuming a grammar is how a
 * scanner ends up stripping something that was code.
 *
 * `none` means the format has no comment syntax at all (JSON), so a content
 * change is behavioural by definition. That is a different and more informative
 * answer than "I could not tell", and both route `high`.
 */
const FAMILY_BY_EXTENSION = Object.freeze({
  '.mjs': 'c_like',
  '.cjs': 'c_like',
  '.js': 'c_like',
  '.json': 'none',
  '.sh': 'hash',
  '.bash': 'hash',
  '.yaml': 'hash',
  '.yml': 'hash',
});

/**
 * Prefixes a trimmed changed line may start with and still be comment-only.
 * The star and star-slash entries cover continuation and closing lines of a
 * block comment.
 */
const COMMENT_LINE_PREFIXES = Object.freeze({
  c_like: ['//', '/*', '*/', '*'],
  hash: ['#'],
  none: [],
});

/** Placeholder that replaces string-literal content in the strings-blanked view. */
const STRING_PLACEHOLDER = '\u0001';

class ScanDesync extends Error {}

/** Comment family for a source path, or null when none is known. */
export function commentFamilyFor(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath === '') return null;
  const match = /(\.[A-Za-z0-9]+)$/.exec(sourcePath);
  if (!match) return null;
  return FAMILY_BY_EXTENSION[match[1].toLowerCase()] ?? null;
}

/**
 * Strip comments and insignificant whitespace, string-aware.
 *
 * Returns two views of the same scan:
 *   `code`     comments removed, trailing whitespace trimmed, blank lines dropped
 *   `blanked`  the same, with every string-literal body replaced by a placeholder
 *
 * `code` identical between two revisions means nothing outside comments and
 * whitespace moved. `blanked` identical means nothing outside comments,
 * whitespace and string *contents* moved.
 *
 * Throws `ScanDesync` when the scanner loses its place — a quoted string in a
 * C-like file running past a newline is the signal, since JS string literals
 * cannot. A desync is reported as `unparseable`, never as clean.
 */
export function scanSource(text, family) {
  if (family === 'none') {
    const code = normalize(text, family);
    return { code, blanked: code };
  }
  const cLike = family === 'c_like';
  const hash = family === 'hash';
  if (!cLike && !hash) throw new ScanDesync(`unknown comment family: ${family}`);

  let code = '';
  let blanked = '';
  let state = 'code';
  let prev = '\n';
  let templateDepth = 0;
  let i = 0;

  // A whole string body collapses to ONE placeholder rather than one per
  // character, so `'old advice'` and `'new advice text'` blank to the same
  // token. Blanking per character would make every length change look like a
  // code change and the `strings_only` verdict would never fire.
  let lastBlankedWasPlaceholder = false;
  const keep = (ch) => { code += ch; blanked += ch; lastBlankedWasPlaceholder = false; };
  const keepAsString = (ch) => {
    code += ch;
    if (ch === '\n') { blanked += '\n'; lastBlankedWasPlaceholder = false; return; }
    if (!lastBlankedWasPlaceholder) { blanked += STRING_PLACEHOLDER; lastBlankedWasPlaceholder = true; }
  };

  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (state === 'code') {
      if (cLike && ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (cLike && ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      // `#` opens a comment only at the start of a word, so `a#b` and `${x#y}`
      // are left alone. Inside quotes we are not in `code` state at all.
      if (hash && ch === '#' && /\s/.test(prev)) { state = 'line'; i += 1; continue; }
      if (ch === "'") { state = 'sq'; keep(ch); prev = ch; i += 1; continue; }
      if (ch === '"') { state = 'dq'; keep(ch); prev = ch; i += 1; continue; }
      if (cLike && ch === '`') { state = 'tpl'; templateDepth = 0; keep(ch); prev = ch; i += 1; continue; }
      keep(ch);
      prev = ch;
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (ch === '\n') { state = 'code'; keep(ch); prev = '\n'; }
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; prev = '/'; i += 2; continue; }
      // Newlines are kept so a stripped block comment does not silently splice
      // the line before it onto the line after it.
      if (ch === '\n') { keep(ch); prev = '\n'; }
      i += 1;
      continue;
    }

    if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"';
      // C-like string literals cannot span a raw newline. Seeing one means the
      // opening quote was not really a quote (a regex body, most likely) and
      // everything after it is suspect.
      if (ch === '\n' && cLike) throw new ScanDesync(`unterminated ${quote}-string`);
      // Backslash escapes apply in C-like strings and in shell/YAML double
      // quotes; single quotes in shell and YAML are literal throughout.
      if (ch === '\\' && (cLike || state === 'dq') && next !== '') {
        keepAsString(ch); keepAsString(next); i += 2; continue;
      }
      if (ch === quote) { state = 'code'; keep(ch); prev = ch; i += 1; continue; }
      keepAsString(ch);
      i += 1;
      continue;
    }

    if (state === 'tpl') {
      // `${...}` contents are treated as string body rather than re-entered as
      // code. That only widens the strings-blanked view, which cannot turn a
      // behavioural change into `comment_only` — `code` still holds every byte.
      if (ch === '\\' && next !== '') { keepAsString(ch); keepAsString(next); i += 2; continue; }
      if (ch === '$' && next === '{') { templateDepth += 1; keepAsString(ch); keepAsString(next); i += 2; continue; }
      if (ch === '}' && templateDepth > 0) { templateDepth -= 1; keepAsString(ch); i += 1; continue; }
      if (ch === '`' && templateDepth === 0) { state = 'code'; keep(ch); prev = ch; i += 1; continue; }
      keepAsString(ch);
      i += 1;
      continue;
    }

    throw new ScanDesync(`scanner reached an impossible state: ${state}`);
  }

  if (state === 'sq' || state === 'dq' || state === 'tpl') throw new ScanDesync('file ends inside a string literal');
  if (state === 'block') throw new ScanDesync('file ends inside a block comment');

  return { code: normalize(code, family), blanked: normalize(blanked, family) };
}

/**
 * Trim insignificant whitespace per line and drop lines that are then empty.
 *
 * Leading indentation is dropped for C-like sources, where it carries no
 * meaning, and KEPT for the `#`-comment family, where YAML indentation is the
 * structure: dropping it there would make moving a key into or out of a block
 * look like a whitespace edit, which is a false `low` on a config change.
 */
function normalize(text, family) {
  const dropIndent = family === 'c_like';
  return text
    .split('\n')
    .map((line) => (dropIndent ? line.trim() : line.replace(/\s+$/, '')))
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Added and removed lines of a unified diff.
 *
 * Deliberately strict: the hunk line counts in every `@@` header must match the
 * body, and a `+`/`-` line outside a hunk is an error. git's own output always
 * satisfies this, so anything that does not is something the caller should not
 * be reasoning about. Throws rather than returning a partial parse.
 */
export function parseUnifiedDiff(diffText) {
  if (typeof diffText !== 'string' || diffText.trim() === '') throw new Error('diff is empty');
  if (/^Binary files .* differ$/m.test(diffText)) throw new Error('diff is binary');

  const added = [];
  const removed = [];
  let hunks = 0;
  let pendingOld = 0;
  let pendingNew = 0;
  let inHunk = false;

  for (const line of diffText.split('\n')) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (inHunk && (pendingOld !== 0 || pendingNew !== 0)) {
        throw new Error('hunk body is shorter than its @@ header claims');
      }
      hunks += 1;
      inHunk = true;
      pendingOld = header[1] === undefined ? 1 : Number(header[1]);
      pendingNew = header[2] === undefined ? 1 : Number(header[2]);
      continue;
    }

    if (!inHunk) {
      // Pre-hunk preamble: `diff --git`, index, mode and ---/+++ lines only.
      if (/^(\+\+\+|---)/.test(line)) continue;
      if (/^[+-]/.test(line)) throw new Error('diff has a changed line before any @@ hunk header');
      continue;
    }

    if (line === '\\ No newline at end of file') continue;
    if (line.startsWith('+')) { added.push(line.slice(1)); pendingNew -= 1; }
    else if (line.startsWith('-')) { removed.push(line.slice(1)); pendingOld -= 1; }
    else if (line.startsWith(' ')) { pendingOld -= 1; pendingNew -= 1; }
    else if (line === '') { if (pendingOld > 0 || pendingNew > 0) { pendingOld -= 1; pendingNew -= 1; } }
    else if (/^(diff --git|index |old mode|new mode|similarity |rename )/.test(line)) { inHunk = false; }
    else throw new Error(`unrecognised diff line: ${line.slice(0, 40)}`);

    if (pendingOld < 0 || pendingNew < 0) throw new Error('hunk body is longer than its @@ header claims');
    if (pendingOld === 0 && pendingNew === 0) inHunk = false;
  }

  if (inHunk && (pendingOld !== 0 || pendingNew !== 0)) {
    throw new Error('hunk body is shorter than its @@ header claims');
  }
  if (hunks === 0) throw new Error('diff has no @@ hunk header');
  return { hunks, added, removed };
}

/**
 * True when no changed line introduces or removes code text.
 *
 * Lines that pair up across the two sides by trimmed content are dropped first:
 * they are a reindent or a trailing-whitespace edit, and they carry no code text
 * that was not already there. Pairing cannot hide a real change, because a moved
 * or reordered line still makes the whole-file strip-and-compare differ, and
 * that comparison is the actual proof. This test exists only to catch the
 * scanner having mis-stripped something, which needs the line to carry code.
 *
 * What survives pairing must be blank or open with a comment marker.
 */
function noChangedLineCarriesCode({ added, removed }, family) {
  const prefixes = COMMENT_LINE_PREFIXES[family] ?? [];
  if (prefixes.length === 0) return false;

  const pool = new Map();
  for (const raw of removed) {
    const key = raw.trim();
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  const unpaired = [];
  for (const raw of added) {
    const key = raw.trim();
    const count = pool.get(key) ?? 0;
    if (count > 0) pool.set(key, count - 1);
    else unpaired.push(key);
  }
  for (const [key, count] of pool) for (let i = 0; i < count; i += 1) unpaired.push(key);

  return unpaired.every((line) => line === '' || prefixes.some((prefix) => line.startsWith(prefix)));
}

/**
 * Bound a diff for inclusion in a report.
 *
 * The report has to be readable in the issue comment it lands in, so long diffs
 * are cut with an explicit line count rather than dropped. A truncated diff is
 * still the difference between "read this and decide" and "go run git yourself",
 * which is the whole point of carrying it.
 */
export function boundDiff(diffText, limit = DEFAULT_DIFF_LINE_LIMIT) {
  if (typeof diffText !== 'string' || diffText === '') {
    return { text: '', totalLines: 0, shownLines: 0, truncated: false };
  }
  // Drop git's file header: the report already names the path and both commits
  // right above the diff, and four redundant lines out of a small budget is four
  // lines of actual change the reader does not get to see.
  const lines = diffText
    .replace(/\n$/, '')
    .split('\n')
    .filter((line) => !/^(diff --git |index [0-9a-f]+\.\.[0-9a-f]+|(old|new) mode |--- |\+\+\+ )/.test(line));
  if (lines.length <= limit) {
    return { text: lines.join('\n'), totalLines: lines.length, shownLines: lines.length, truncated: false };
  }
  const shown = lines.slice(0, limit);
  return {
    text: `${shown.join('\n')}\n... ${lines.length - limit} more diff line${lines.length - limit === 1 ? '' : 's'} truncated (${lines.length} total)`,
    totalLines: lines.length,
    shownLines: limit,
    truncated: true,
  };
}

/** Human-readable one-liners, kept next to the verdicts they describe. */
const VERDICT_LABEL = Object.freeze({
  comment_only: 'only comments and whitespace moved; stripping comments from both revisions yields identical files',
  strings_only: 'only string-literal text moved; code structure is unchanged, but a changed string is still a changed program value',
  behavioural: 'code outside comments and string text changed',
  unparseable: 'the delta could not be classified, so it is treated as behavioural',
});

/**
 * Classify a stale delta. Returns `{ verdict, severity, label, reason, family }`.
 *
 * `severity` is only ever `'low'` or `'high'`; the caller applies it to `stale`
 * findings and to nothing else.
 */
export function classifyStaleChange({
  sourcePath,
  beforeText,
  afterText,
  diffText,
  treatStringsAsNonBehavioural = false,
} = {}) {
  const family = commentFamilyFor(sourcePath);
  const verdict = (v, reason) => ({
    verdict: v,
    severity: v === 'comment_only' || (v === 'strings_only' && treatStringsAsNonBehavioural) ? 'low' : 'high',
    label: VERDICT_LABEL[v],
    reason,
    family,
  });

  if (!family) return verdict('unparseable', `no comment grammar is known for \`${sourcePath ?? '(no source path)'}\``);
  if (typeof beforeText !== 'string' || typeof afterText !== 'string') {
    return verdict('unparseable', 'the blob content at one of the two commits was not available as text');
  }
  if (beforeText.includes('\u0000') || afterText.includes('\u0000')) {
    return verdict('unparseable', 'the file is binary');
  }

  let changed;
  try {
    changed = parseUnifiedDiff(diffText);
  } catch (err) {
    return verdict('unparseable', `the diff could not be parsed: ${err.message}`);
  }
  if (changed.added.length === 0 && changed.removed.length === 0) {
    // The digests differ, so something moved. A diff that shows nothing is a
    // contradiction and the safe reading is that the diff is wrong, not that
    // the change is empty.
    return verdict('unparseable', 'the digests differ but the diff shows no added or removed lines');
  }

  let before;
  let after;
  try {
    before = scanSource(beforeText, family);
    after = scanSource(afterText, family);
  } catch (err) {
    return verdict('unparseable', `the comment scanner lost its place: ${err.message}`);
  }

  if (before.code === after.code && noChangedLineCarriesCode(changed, family)) {
    return verdict('comment_only',
      `${changed.added.length} added and ${changed.removed.length} removed line(s), none of them carrying code text`);
  }
  if (before.blanked === after.blanked) {
    return verdict('strings_only',
      'read the diff before deciding it is cosmetic — a string can hold a repo name, a ref or a permission');
  }
  return verdict('behavioural',
    `${changed.added.length} added and ${changed.removed.length} removed line(s) across ${changed.hunks} hunk(s)`);
}
