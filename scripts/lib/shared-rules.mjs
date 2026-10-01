export const SHARED_START = '<!-- shared-rules:start -->';
export const SHARED_END = '<!-- shared-rules:end -->';

/** The shared file's text wrapped in markers, with exactly one trailing newline. */
export function sharedBlock(shared) {
  return `${SHARED_START}\n${shared.trim()}\n${SHARED_END}\n`;
}

/**
 * Return `agents/<x>/AGENTS.md` text with the shared rules block present and current.
 * Replaces an existing marked block in place; otherwise appends one after the existing content.
 * Pure and idempotent: applying twice equals applying once.
 */
export function withSharedRules(text, shared) {
  const block = sharedBlock(shared);
  const s = text.indexOf(SHARED_START);
  const e = text.indexOf(SHARED_END);
  if (s !== -1 && e !== -1 && e > s) {
    return text.slice(0, s) + block + text.slice(e + SHARED_END.length).replace(/^\n/, '');
  }
  if ((s === -1) !== (e === -1)) throw new Error('shared-rules: AGENTS.md has only one of the two markers');
  return `${text.replace(/\s+$/, '')}\n\n${block}`;
}
