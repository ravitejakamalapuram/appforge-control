/**
 * Classify a launcher-file change as behavioural or not (APP-261).
 *
 * WHY THIS EXISTS
 *
 * `buildReport` rates *any* content change to a versioned launcher file as
 * `stale`/`high` and routes it to the CEO. It reports blob hashes and never
 * what changed, so a silently-inert safety control (the APP-72 / APP-137
 * failure class the check exists to catch) and a comment edit arrive looking
 * identical.
 *
 * That cost has been paid twice. On APP-226 a five-line `collateralNote`
 * advice string was escalated as `high` under the headline "Production is not
 * running that fix"; the CEO read the diff by hand, found the claim wrong, and
 * corrected it to `low` — one ruling and one board approval spent to reach
 * "routine". On APP-260 the detector rated a pure-documentation edit to
 * `config/github-apps.yaml` `high`, on a file whose comment-stripped content
 * was byte-identical across the two revisions.
 *
 * The cost of the miss runs the wrong way. An operator who watches comment
 * edits escalate as `high` learns to discount the check, and a discounted
 * alarm is how the APP-72 blind spot comes back.
 *
 * FAIL TOWARD `high`
 *
 * Every uncertainty in this module resolves to behavioural. An unknown file
 * type, an unreadable blob, a missing diff, a syntax this module does not
 * model, a mixed change — all behavioural. A false `low` reintroduces the
 * blind spot that justifies the whole check; a false `high` costs one read.
 *
 * NEVER SUPPRESSES
 *
 * This module returns a classification. It does not decide whether a finding
 * exists, and the caller wires it into `stale` findings only. `tampered`,
 * `missing` and `manifest_mismatch` stay `critical` whatever the delta is: an
 * unexplained hand-edit to the credential-bearing launcher tree is serious
 * because it is unexplained, not because of what it touched.
 *
 * WHOLE-FILE EQUIVALENCE, NOT HUNK PARSING
 *
 * Classification compares normalised whole files, not diff hunks. A hunk
 * parser has to decide whether an added `//` line is a comment or the middle
 * of a block comment or the inside of a string, and it gets it wrong at the
 * edges. Normalising both revisions and comparing them is decidable: if
 * stripping comments and blank lines from both sides yields identical bytes,
 * nothing that executes changed, and no hunk arithmetic can argue otherwise.
 *
 * WHAT IS MODELLED, PER FILE TYPE
 *
 *   .mjs .js .cjs   comments + string literals
 *   .sh .bash       comments only
 *   .yaml .yml      comments only
 *   .gitconfig*     comments only
 *   .json           nothing — JSON has no comments, so any change is content
 *   anything else   nothing — unknown type is behavioural
 *
 * In shell and YAML a `#` opens a comment only at the start of a word, and a
 * `#!` at byte 0 is the interpreter line, never a comment. A file holding a
 * heredoc or a YAML block scalar is `unmodelled_construct`: a `#` line inside
 * either is data (PR #53 review, 2026-10-01).
 *
 * Shell and YAML get comment detection but no string handling on purpose.
 * Shell quoting (`$` expansion inside double quotes, `$'...'`, heredocs) and
 * YAML's unquoted scalars are both too easy to model wrongly, and a wrong
 * model here produces a false `low`. Comment stripping in both is a one-rule
 * job that is right.
 */

/** Line-comment and string syntax per file extension. `null` = not modelled. */
const SYNTAX = Object.freeze({
  mjs: { line: ['//'], block: [['/*', '*/']], strings: true, shebang: true },
  js: { line: ['//'], block: [['/*', '*/']], strings: true, shebang: true },
  cjs: { line: ['//'], block: [['/*', '*/']], strings: true, shebang: true },
  sh: { line: ['#'], block: [], strings: false, wordStart: true, shebang: true },
  bash: { line: ['#'], block: [], strings: false, wordStart: true, shebang: true },
  yaml: { line: ['#'], block: [], strings: false, wordStart: true },
  yml: { line: ['#'], block: [], strings: false, wordStart: true },
  gitconfig: { line: ['#', ';'], block: [], strings: false },
  json: null,
});

/**
 * Constructs inside which a `#` line is data, not a comment. A shell heredoc
 * body and a YAML block scalar are both verbatim text, so stripping a `#` line
 * from one hides a real change. Tracking where each ends is exactly the kind of
 * modelling the note above declines to do, so their mere presence in either
 * revision makes the file unmodelled. The patterns over-match on purpose: an
 * over-match costs a read, an under-match is a false `low`.
 */
const UNMODELLED_CONSTRUCTS = Object.freeze({
  sh: /<<-?\s*['"]?[A-Za-z_]/,
  bash: /<<-?\s*['"]?[A-Za-z_]/,
  yaml: /(^|\s|:|-)[|>][-+0-9]*[ \t]*(#.*)?$/m,
  yml: /(^|\s|:|-)[|>][-+0-9]*[ \t]*(#.*)?$/m,
});

/** True when either revision holds a construct this module cannot strip safely. */
export function hasUnmodelledConstruct(sourcePath, ...texts) {
  const base = typeof sourcePath === 'string' ? sourcePath.split('/').pop() : '';
  const pattern = UNMODELLED_CONSTRUCTS[base.slice(base.lastIndexOf('.') + 1).toLowerCase()];
  return Boolean(pattern) && texts.some((t) => pattern.test(t));
}

/** Classifications this module can return, and whether each is behavioural. */
export const CLASSIFICATIONS = Object.freeze({
  comment_only: {
    behavioural: false,
    label: 'comment/whitespace only',
    note: 'stripping comments and blank lines from both revisions yields byte-identical files, so nothing that executes changed.',
  },
  prose_string_only: {
    behavioural: false,
    label: 'prose string literals only',
    note: 'the code skeleton is byte-identical and every changed literal is multi-word prose passed directly to a message sink (console.*, new Error, stderr/stdout.write) — the APP-226 `collateralNote` class. A literal anywhere else may be a match key, so it is never prose here however it reads.',
  },
  string_only: {
    behavioural: true,
    label: 'string literals, not prose',
    note: 'the code skeleton is byte-identical but at least one changed literal is a flag, path, URL, command or bare token — a string that short is routinely operative (`--dry-run` to `--force` changes no skeleton at all).',
  },
  behavioural: {
    behavioural: true,
    label: 'behavioural',
    note: 'executable content changed.',
  },
  unmodelled_construct: {
    behavioural: true,
    label: 'construct not modelled',
    note: 'the file contains a shell heredoc or a YAML block scalar. A `#` line inside one is data, not a comment, and this module does not track where they start and end — so it cannot rule out a behavioural change.',
  },
  unmodelled_filetype: {
    behavioural: true,
    label: 'file type not modelled',
    note: 'this module has no comment or string model for this extension, so it cannot rule out a behavioural change.',
  },
  unavailable: {
    behavioural: true,
    label: 'diff unavailable',
    note: 'the two revisions of this file could not be read, so the change could not be inspected.',
  },
  unparseable: {
    behavioural: true,
    label: 'unparseable',
    note: 'normalising the two revisions threw, so the change could not be inspected.',
  },
});

/** Syntax table lookup. `.gitconfig-appforge` and friends match on basename. */
export function syntaxFor(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath === '') return undefined;
  const base = sourcePath.split('/').pop();
  if (base.startsWith('.gitconfig')) return SYNTAX.gitconfig;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return SYNTAX[base.slice(dot + 1).toLowerCase()];
}

/**
 * Strip comments and blank lines, and trim trailing whitespace.
 *
 * Single-pass character scan so a `//` inside a string literal and a `#`
 * inside a quoted YAML scalar are not mistaken for comments. For a syntax
 * with `strings: false` the scanner still tracks quotes — it has to, or the
 * `#` in `password = "a#b"` truncates the line — it just does not go on to
 * blank the contents.
 */
export function stripComments(text, syntax) {
  const out = [];
  let i = 0;
  let line = '';
  let quote = null; // the open quote char, or null

  // A `#!` at byte 0 is the interpreter line, not a comment: `#!/bin/bash` to
  // `#!/bin/sh` changes what runs the file. Anywhere else `#!` is a comment.
  if (syntax.shebang && text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    line = nl === -1 ? text : text.slice(0, nl);
    i = nl === -1 ? text.length : nl;
  }

  const flush = () => {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed.trim() !== '') out.push(trimmed);
    line = '';
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\n') {
      // Inside an open quote a newline, and any blank line after it, is part
      // of the value. Flushing there would drop a blank line added to a
      // template or a multi-line shell string and call the change cosmetic.
      if (quote) {
        line += ch;
        i += 1;
        continue;
      }
      flush();
      i += 1;
      continue;
    }

    if (quote) {
      line += ch;
      if (ch === '\\' && i + 1 < text.length) {
        line += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      line += ch;
      i += 1;
      continue;
    }

    const block = syntax.block.find(([open]) => text.startsWith(open, i));
    if (block) {
      const end = text.indexOf(block[1], i + block[0].length);
      if (end === -1) throw new Error('unterminated block comment');
      // A block comment spanning newlines ends the lines it swallowed.
      const swallowed = text.slice(i, end + block[1].length);
      i = end + block[1].length;
      if (swallowed.includes('\n')) flush();
      continue;
    }

    // In shell and YAML `#` opens a comment only at the start of a word:
    // `echo a#b` and `url: http://x/#frag` carry no comment at all.
    const atWordStart = !syntax.wordStart || line === '' || /\s$/.test(line);
    if (atWordStart && syntax.line.some((marker) => text.startsWith(marker, i))) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }

    line += ch;
    i += 1;
  }
  flush();

  if (quote) throw new Error('unterminated string literal');
  return out.join('\n');
}

/**
 * Replace the contents of `'...'` and `"..."` with a placeholder, and collect
 * what was replaced in source order.
 *
 * Backtick template literals are deliberately left alone. A template can carry
 * `${...}` expressions, which are code, and blanking one would hide a real
 * change inside an interpolation. Leaving them intact means a changed template
 * shows up as a skeleton difference and lands on `behavioural` — the safe way
 * round.
 */
export function blankStrings(text) {
  let out = '';
  const literals = [];
  const sinkBound = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '`') {
      // Copy the whole template through verbatim, contents and all.
      out += ch;
      i += 1;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\' && i + 1 < text.length) {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += text[i];
        i += 1;
      }
      if (i >= text.length) throw new Error('unterminated template literal');
      out += '`';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let body = '';
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\' && i + 1 < text.length) {
          body += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (text[i] === '\n') throw new Error('unterminated string literal');
        body += text[i];
        i += 1;
      }
      if (i >= text.length) throw new Error('unterminated string literal');
      i += 1;
      const before = out;
      const continues = /\u0000STR\u0000\s*\+\s*$/.test(before) && sinkBound[sinkBound.length - 1] === true;
      sinkBound.push((MESSAGE_SINK.test(before) || continues) && /^\s*[)+,]/.test(text.slice(i)));
      literals.push(body);
      out += '\u0000STR\u0000';
      continue;
    }
    out += ch;
    i += 1;
  }
  return { skeleton: out, literals, sinkBound };
}

/**
 * Calls whose string argument is only ever shown to a human. A literal is
 * prose-eligible only as a direct argument to one of these (or a `+`
 * continuation of one that is). A literal anywhere else — a comparison, an
 * `.includes()`, a pattern list read three functions away — may be a match
 * key, and a changed match key is the silent-inert failure itself.
 */
const MESSAGE_SINK = /(?:^|[^\w$.])(?:console\.(?:log|error|warn|info)|new Error|process\.(?:stderr|stdout)\.write)\(\s*$/;

/**
 * Shapes that veto the prose reading however many words a literal has.
 *
 * A multi-word string is usually a message, but SQL, a URL and a shell command
 * line are all multi-word and all operative. This list is short by intent: it
 * covers the operative multi-word forms that actually appear in this tree, and
 * everything it misses still shows up in the hunks the report now carries.
 */
const OPERATIVE_SHAPES = [
  /:\/\//,
  /^\s*(select|insert|update|delete|create|drop|alter)\s/i,
  /^\s*(rm|git|curl|wget|chmod|chown|sudo|node|npm|npx|gh|bash|sh|kill|launchctl)\s/,
];

/**
 * True for a literal that reads as human prose rather than an operative token.
 *
 * The bar is four whitespace-separated words. One and two-token literals are
 * where the flags, paths, identifiers, status values and comparison keys live,
 * and a swap among those changes no skeleton — `'--dry-run'` to `'--force'`,
 * `'blocked'` to `'blockd'` — which is exactly the silent-inert failure this
 * check exists to catch. Prose that short is not worth the blind spot.
 */
export function isProseLiteral(literal) {
  if (typeof literal !== 'string') return false;
  const text = literal.trim();
  if (text === '') return true; // whitespace-only padding, e.g. a message joiner
  if (OPERATIVE_SHAPES.some((re) => re.test(text))) return false;
  return text.split(/\s+/).filter(Boolean).length >= 4;
}

/**
 * Every added or removed line of a unified diff, `+`/`-` markers stripped.
 * File headers (`+++`, `---`) and hunk headers are not content.
 */
export function changedDiffLines(diffText) {
  const out = [];
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) out.push(line.slice(1));
  }
  return out;
}

/**
 * Independent corroboration of a `comment_only` verdict: every changed raw
 * line must itself look inert.
 *
 * `stripComments` is a hand-written scanner, and a scanner that loses quote
 * state in one direction could strip a code line from both revisions and call
 * the result identical. That is the one failure mode of this module that
 * produces a false `low`, so the verdict has to survive a second check that
 * shares no code with the first. A `comment_only` claim the raw lines do not
 * support is downgraded, not trusted.
 *
 * This is strictly a veto. It can only move a verdict toward `behavioural`.
 */
export function changedLinesLookInert(diffText, syntax) {
  return changedDiffLines(diffText).every((raw) => {
    const text = raw.trim();
    if (text === '') return true;
    // Could be the interpreter line. A diff line carries no line number here,
    // so every `#!` line is treated as one — the safe way round.
    if (syntax.shebang && text.startsWith('#!')) return false;
    if (syntax.line.some((marker) => text.startsWith(marker))) return true;
    // Block-comment interior, as JSDoc and friends write it.
    return syntax.block.length > 0 && /^([*]|\/\*|\*\/)/.test(text);
  });
}

/**
 * Classify the change between two revisions of one file.
 *
 * `before`/`after` are the full file texts and `diffText` is the unified diff
 * between them. Passing a hunk as `before` would defeat the whole-file
 * equivalence this relies on, so a non-string on any of the three is
 * `unavailable` rather than an attempt to guess. A caller with no diff has
 * nothing to put in the report either, so that is the same answer twice.
 *
 * Returns `{ classification, behavioural, label, note, changedLiterals }`.
 */
export function classifyChange({ sourcePath, before, after, diffText } = {}) {
  const result = (classification, extra = {}) => ({
    classification,
    behavioural: CLASSIFICATIONS[classification].behavioural,
    label: CLASSIFICATIONS[classification].label,
    note: CLASSIFICATIONS[classification].note,
    ...extra,
  });

  if (typeof before !== 'string' || typeof after !== 'string' || typeof diffText !== 'string') {
    return result('unavailable');
  }

  const syntax = syntaxFor(sourcePath);
  if (!syntax) return result('unmodelled_filetype');
  if (hasUnmodelledConstruct(sourcePath, before, after)) return result('unmodelled_construct');

  let strippedBefore;
  let strippedAfter;
  try {
    strippedBefore = stripComments(before, syntax);
    strippedAfter = stripComments(after, syntax);
  } catch (err) {
    return result('unparseable', { error: err.message });
  }

  const commentOnly = (extra) => (changedLinesLookInert(diffText, syntax)
    ? result('comment_only', extra)
    : result('behavioural', {
      ...extra,
      note: `${CLASSIFICATIONS.behavioural.note} The comment-stripped revisions match, but at least one changed raw line is not a comment, so that match is not trusted.`,
    }));

  if (strippedBefore === strippedAfter) return commentOnly({});
  if (!syntax.strings) return result('behavioural');

  let skeletonBefore;
  let skeletonAfter;
  try {
    skeletonBefore = blankStrings(strippedBefore);
    skeletonAfter = blankStrings(strippedAfter);
  } catch (err) {
    return result('unparseable', { error: err.message });
  }

  if (skeletonBefore.skeleton !== skeletonAfter.skeleton) return result('behavioural');

  // Same skeleton means the same literal count by construction, so the only
  // remaining differences are literal contents.
  const changedLiterals = [];
  for (let i = 0; i < skeletonAfter.literals.length; i += 1) {
    const from = skeletonBefore.literals[i];
    const to = skeletonAfter.literals[i];
    if (from !== to) changedLiterals.push({ from, to, sinkBound: skeletonAfter.sinkBound[i] && skeletonBefore.sinkBound[i] });
  }
  if (changedLiterals.length === 0) return commentOnly({ changedLiterals });

  const allProse = changedLiterals.every((pair) => pair.sinkBound && isProseLiteral(pair.from) && isProseLiteral(pair.to));
  return result(allProse ? 'prose_string_only' : 'string_only', { changedLiterals });
}
