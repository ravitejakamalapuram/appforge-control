// A deliberately tiny, deliberately strict parser for `when_all` clauses.
//
// Why a parser at all, rather than a general expression evaluator: the one
// thing this evaluator must never do is treat a clause it does not
// understand as `false`. A general evaluator fails soft (undefined compares
// false and a rule quietly does not fire); this one fails closed (an
// unrecognised clause form throws, at config load, before any verdict).
//
// Every clause form below is one that actually appears in config/portfolio.yaml.
// Adding a new clause shape to the config without teaching this parser is a
// load-time crash, which is the intended pressure: the config and the script
// cannot drift into disagreement silently.

export class ClauseParseError extends Error {
  constructor(clause, ruleId) {
    super(
      `unparseable clause in rule \`${ruleId}\`: ${JSON.stringify(clause)}\n` +
        `  Refusing to score it. An unrecognised clause is never "false" — see ` +
        `resolution.forbidden ("Treating an undecidable rule as not-fired").`
    );
    this.name = 'ClauseParseError';
    this.clause = clause;
    this.ruleId = ruleId;
  }
}

const IDENT = String.raw`[a-z_][a-z0-9_]*`;
const OP = String.raw`<=|>=|==|!=|<|>`;
const NUM = String.raw`-?\d+(?:\.\d+)?`;

// `checkpoint >= day_90`
const RE_CHECKPOINT = new RegExp(`^checkpoint\\s+(${OP})\\s+day_(\\d+)$`);
// `wau_growth_monthly >= 0.10 for 2 consecutive months`
const RE_SUSTAINED = new RegExp(`^(${IDENT})\\s+(${OP})\\s+(${NUM})\\s+for\\s+(\\d+)\\s+consecutive\\s+(month|months|week|weeks|quarter|quarters)$`);
// `maintenance_cost_monthly > 3 * contribution`
const RE_SCALED = new RegExp(`^(${IDENT})\\s+(${OP})\\s+(${NUM})\\s*\\*\\s*(${IDENT})$`);
// `revenue_path_validated == false`
const RE_BOOL = new RegExp(`^(${IDENT})\\s+(==|!=)\\s+(true|false)$`);
// `cws_weekly_users < 50`
const RE_NUMERIC = new RegExp(`^(${IDENT})\\s+(${OP})\\s+(${NUM})$`);

function parseAtom(text, ruleId) {
  const s = text.trim();
  let m;
  if ((m = RE_CHECKPOINT.exec(s))) {
    return { kind: 'checkpoint', op: m[1], days: Number(m[2]), terms: ['checkpoint'], text: s };
  }
  if ((m = RE_SUSTAINED.exec(s))) {
    return {
      kind: 'sustained',
      metric: m[1], op: m[2], value: Number(m[3]),
      periods: Number(m[4]), unit: m[5].replace(/s$/, ''),
      terms: [m[1]], text: s,
    };
  }
  if ((m = RE_SCALED.exec(s))) {
    return { kind: 'scaled', metric: m[1], op: m[2], factor: Number(m[3]), against: m[4], terms: [m[1], m[4]], text: s };
  }
  if ((m = RE_BOOL.exec(s))) {
    return { kind: 'bool', metric: m[1], op: m[2], value: m[3] === 'true', terms: [m[1]], text: s };
  }
  if ((m = RE_NUMERIC.exec(s))) {
    return { kind: 'numeric', metric: m[1], op: m[2], value: Number(m[3]), terms: [m[1]], text: s };
  }
  throw new ClauseParseError(text, ruleId);
}

/** A clause is a disjunction of atoms. `A or B` is the only connective in the config. */
export function parseClause(text, ruleId) {
  const parts = String(text).split(/\s+or\s+/);
  const atoms = parts.map((p) => parseAtom(p, ruleId));
  return { text: String(text), atoms, terms: [...new Set(atoms.flatMap((a) => a.terms))] };
}

/** Parse every clause of every rule. Throws on the first unparseable one. */
export function compileRules(doc) {
  const compiled = new Map();
  for (const rule of doc.rules ?? []) {
    const clauses = (rule.when_all ?? []).map((c) => parseClause(c, rule.id));
    compiled.set(rule.id, {
      rule,
      clauses,
      // Every term the rule actually READS, which is a superset of `requires`:
      // `scale` reads marketing_spend and `iterate_distribution_problem` reads
      // acquisition_weak, neither of which is listed in `requires`. Scoring a
      // clause whose term cannot be resolved is exactly the failure this
      // evaluator exists to prevent, so the sufficiency gate uses the union.
      terms: [...new Set(clauses.flatMap((c) => c.terms))],
    });
  }
  return compiled;
}

export function compare(op, a, b) {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '==': return a === b;
    case '!=': return a !== b;
    default: throw new Error(`unknown operator ${op}`);
  }
}
