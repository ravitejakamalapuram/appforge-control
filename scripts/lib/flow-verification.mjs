// Guards the flow-verification convention (APP-290, docs/flow-verification.md): the doc keeps
// its definition-of-done items, PR template, reviewer checklist and audit table, and the agents
// that open or review PRs keep pointing at it. Returns one line per problem; [] means intact.
export const DOD_ITEMS = ['Intended end state', 'Source of truth', 'Read-back method', 'When', 'Who is told on a mismatch', 'Mutation test'];
export const TEMPLATE_LINES = ['- Intended end state:', '- Source of truth + read-back:', '- When:', '- On mismatch:', '- Mutation test:'];
export const AGENTS_NEEDING_RULE = ['builder', 'cto', 'qa'];

export function checkConvention({ doc, agents }) {
  const problems = [];
  for (const item of DOD_ITEMS) if (!doc.includes(`**${item}**`)) problems.push(`doc: definition of done lacks "${item}"`);
  if (!doc.includes('## Verification')) problems.push('doc: no "## Verification" PR template');
  for (const line of TEMPLATE_LINES) if (!doc.includes(line)) problems.push(`doc: PR template lacks "${line}"`);
  if (!/## 3\. Reviewer checklist[\s\S]*?- \[ \]/.test(doc)) problems.push('doc: reviewer checklist missing');
  if (!/## 4\. Retrofit audit[\s\S]*?\| Rank \| Flow \|/.test(doc)) problems.push('doc: retrofit audit table missing');
  for (const name of AGENTS_NEEDING_RULE) {
    const text = agents[name] ?? '';
    if (!text.includes('docs/flow-verification.md')) problems.push(`agents/${name}/AGENTS.md: does not point at docs/flow-verification.md`);
    if (name !== 'qa' && !text.includes('`## Verification`')) problems.push(`agents/${name}/AGENTS.md: no mandatory \`## Verification\` PR section`);
  }
  return problems;
}
