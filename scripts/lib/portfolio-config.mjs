// config/portfolio.yaml loader + the section 5a STRUCTURAL INVARIANTS (APP-43).
//
// The config says what this module must do, and it is not a suggestion:
//
//   "The evaluator (APP-43) MUST evaluate them when it loads this config and
//    MUST fail closed — refuse to produce any verdict at all — if one fails.
//    A warning is not compliance."
//
// So `loadPortfolio` throws. There is no code path that returns a usable
// config object alongside a failed invariant, because a caller holding such
// an object would be one `if` away from emitting a verdict the config forbids.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** Thrown when a section 5a invariant fails. Carries every failure, not the first. */
export class PortfolioConfigError extends Error {
  constructor(failures) {
    super(
      `portfolio config failed ${failures.length} structural invariant(s):\n` +
        failures.map((f) => `  - ${f.id}: ${f.detail}`).join('\n')
    );
    this.name = 'PortfolioConfigError';
    this.failures = failures;
  }
}

/**
 * `store_item_status` enum.
 *
 * The config carries this enum only in a comment under `evaluation:`
 * ("# store_item_status ∈ [published, draft, unlisted, internal_track,
 * unpublished]"), so it cannot be parsed out of the YAML tree. It is restated
 * here and `scripts/tests/portfolio-config.test.mjs` asserts this array
 * against that comment line, so config drift fails a test rather than
 * silently widening what the evaluator will accept.
 */
export const STORE_ITEM_STATUS = Object.freeze([
  'published',
  'draft',
  'unlisted',
  'internal_track',
  'unpublished',
]);

const STORE_ORIGIN = 'store';

/** Metric ids whose `origin` is `store`. Used by no_store_only_sunset_or_scale. */
export function storeOriginMetrics(doc) {
  return new Set(
    Object.entries(doc.metrics ?? {})
      .filter(([, spec]) => spec?.origin === STORE_ORIGIN)
      .map(([name]) => name)
  );
}

// --- section 5a invariants -------------------------------------------------

function invStoreOnly(doc) {
  const store = storeOriginMetrics(doc);
  const failures = [];
  for (const rule of doc.rules ?? []) {
    if (!['SUNSET', 'SCALE'].includes(rule.outcome)) continue;
    const requires = rule.requires ?? [];
    if (requires.length === 0) {
      failures.push(`rule \`${rule.id}\` has outcome ${rule.outcome} and requires nothing at all`);
      continue;
    }
    if (requires.every((m) => store.has(m))) {
      failures.push(
        `rule \`${rule.id}\` (outcome ${rule.outcome}) requires only store-origin metrics [${requires.join(', ')}] — ` +
          `store data describes reach, never use, retention or economics`
      );
    }
  }
  return failures;
}

function invForbiddenAlias(doc) {
  // "the validator checks that both members of each pair are never resolved
  // from the same source field in the ingest manifest" — two metrics sharing
  // a (source, field) pair ARE the same reading wearing two names.
  const metrics = doc.metrics ?? {};
  const key = (m) => {
    const s = metrics[m];
    if (!s) return null;
    if (s.source == null && s.field == null) return null; // derived / composite
    return `${JSON.stringify(s.source)}::${s.field ?? ''}`;
  };
  const failures = [];
  for (const { pair, why } of doc.forbidden_aliases ?? []) {
    const [a, b] = pair;
    const ka = key(a);
    const kb = key(b);
    if (ka != null && ka === kb) {
      failures.push(`\`${a}\` and \`${b}\` both resolve from ${ka} — ${why}`);
    }
  }
  return failures;
}

function invEveryMetricDeclaresOrigin(doc) {
  return Object.entries(doc.metrics ?? {})
    .filter(([, spec]) => spec?.origin == null)
    .map(([name]) => `metric \`${name}\` declares no \`origin\``);
}

function invRetentionNeverProxied(doc) {
  const failures = [];
  const spec = doc.metrics?.retention_d30;
  if (!spec) {
    failures.push('metric `retention_d30` is absent from the config entirely');
    return failures;
  }
  if (spec.never_proxy !== true) {
    failures.push('`metrics.retention_d30.never_proxy` must remain true (DEC-0009 D3)');
  }
  const proxies = doc.allocation?.proxies ?? {};
  if (Object.prototype.hasOwnProperty.call(proxies, 'retention_d30')) {
    failures.push('`allocation.proxies` contains retention_d30');
  }
  for (const [name, p] of Object.entries(proxies)) {
    if (p?.proxies_for && /retention_d30/.test(String(p.proxies_for))) {
      failures.push(`allocation proxy \`${name}\` declares itself a proxy for retention_d30`);
    }
  }
  // "No entry anywhere in this file may declare a proxy, substitute,
  // fallback, estimate or default for retention_d30."
  for (const bad of ['proxy', 'substitute', 'fallback', 'estimate', 'default']) {
    if (spec[bad] != null) failures.push(`\`metrics.retention_d30.${bad}\` is set`);
  }
  return failures;
}

function invReasonCodeRegistry(doc) {
  const reg = doc.reason_codes ?? {};
  const failures = [];
  if (Object.keys(reg).length === 0) {
    failures.push('`reason_codes` registry is empty — every non-verdict outcome must draw from it');
  }
  // Every reason_code named on a rule or platform rule set must be registered.
  for (const rule of doc.rules ?? []) {
    for (const rc of rule.reason_codes ?? []) {
      if (!(rc in reg)) failures.push(`rule \`${rule.id}\` names unregistered reason code \`${rc}\``);
    }
    const arc = rule.android_behaviour?.reason_code;
    if (arc && !(arc in reg)) {
      failures.push(`rule \`${rule.id}\`.android_behaviour names unregistered reason code \`${arc}\``);
    }
  }
  return failures;
}

function invNoDefaultOutcome(doc) {
  const failures = [];
  if (doc.default_outcome !== null && doc.default_outcome !== undefined) {
    failures.push(`\`default_outcome\` must be null, found ${JSON.stringify(doc.default_outcome)}`);
  }
  if (doc.resolution?.no_fallthrough !== true) {
    failures.push('`resolution.no_fallthrough` must be true');
  }
  return failures;
}

function invOutputContractPresent(doc) {
  // Not a numbered 5a invariant, but output_contract.insufficient_data_notice
  // carries `integrity_check`: the evaluator "should assert this string
  // against the config at startup rather than embedding its own copy. If the
  // two differ, that is a validator failure." Embedding no copy at all is the
  // strongest form of that: we fail if the config cannot supply the string.
  const failures = [];
  const n = doc.output_contract?.insufficient_data_notice;
  if (!n?.text || typeof n.text !== 'string' || n.text.trim() === '') {
    failures.push('`output_contract.insufficient_data_notice.text` is missing or empty');
  }
  const w = doc.output_contract?.allocation_withheld_notice;
  if (!w?.text || typeof w.text !== 'string' || w.text.trim() === '') {
    failures.push('`output_contract.allocation_withheld_notice.text` is missing or empty');
  }
  return failures;
}

const INVARIANTS = [
  ['no_store_only_sunset_or_scale', invStoreOnly],
  ['no_forbidden_alias_in_any_rule', invForbiddenAlias],
  ['every_metric_declares_origin', invEveryMetricDeclaresOrigin],
  ['retention_d30_never_proxied', invRetentionNeverProxied],
  ['every_non_verdict_carries_a_reason_code', invReasonCodeRegistry],
  ['no_default_outcome', invNoDefaultOutcome],
  ['output_contract_supplies_verbatim_text', invOutputContractPresent],
];

/** Run every section 5a invariant. Returns every failure, never just the first. */
export function validatePortfolio(doc) {
  const failures = [];
  for (const [id, fn] of INVARIANTS) {
    for (const detail of fn(doc)) failures.push({ id, detail });
  }
  return failures;
}

/**
 * Load and validate. Throws PortfolioConfigError on any invariant failure —
 * fail closed, per `validator.fail_closed: true`.
 */
export function loadPortfolio(portfolioPath) {
  const doc = parseYaml(readFileSync(portfolioPath, 'utf8'));
  const failures = validatePortfolio(doc);
  if (failures.length > 0) throw new PortfolioConfigError(failures);
  return doc;
}

/** The verbatim notice, read from config. Never a copy held in this repo's code. */
export function insufficientDataNotice(doc) {
  return doc.output_contract.insufficient_data_notice.text;
}

export function allocationWithheldNotice(doc, coverage) {
  return doc.output_contract.allocation_withheld_notice.text.replace(
    '<X>',
    coverage.toFixed(2)
  );
}

/** Outcome precedence, highest first, straight from `precedence:`. */
export function precedenceRank(doc, outcome) {
  const i = (doc.precedence ?? []).indexOf(outcome);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
