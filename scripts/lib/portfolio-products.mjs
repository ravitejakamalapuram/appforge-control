// Product-level inputs for the §22.1 evaluator: the two scalars
// `resolution.order` reads before any metric (APP-43, contract from APP-86).
//
// APP-86's requirement, in full, because it is the whole reason this file is
// separate from the evaluator:
//
//   resolution.order step 1 reads "If `store_item_status != published` →
//   not_applicable, reason_code not_published. Stop." Against a product.yaml
//   that LACKS the key, `absent != published` is true, so a direct
//   implementation emits not_applicable/not_published. For InvTrack that is
//   factually wrong — the Play listing is live, publicly installable, 100+
//   downloads — and `not_published` reads as "nothing to see here" on a
//   product holding real user financial data.
//
// So: absent and `!= published` are different inputs and do not collapse.
//
//   - key ABSENT          -> hard error, non-zero exit, product named
//   - value OUT OF ENUM   -> hard error
//   - present, in enum, not `published` -> not_applicable / not_published
//
// The same reasoning `resolution.forbidden` already applies to metrics
// ("Substituting 0 for a missing metric") applied to the product scalars.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { STORE_ITEM_STATUS } from './portfolio-config.mjs';

export const PRODUCT_YAML_RELPATH = join('.appforge', 'product.yaml');

/** The nine products, as repo directory names under the products root. */
export const PRODUCT_REPOS = Object.freeze([
  'json-workbench',
  'echokit',
  'StellarTab',
  'session-transfer',
  'TeluguPanchangam',
  'GitaVerses',
  'cors-enabler',
  'TelePort',
  'InvTrack',
]);

/**
 * Read one product.yaml and check the two scalars.
 *
 * Returns `{ product, ok: true, ... }` or `{ ok: false, problems }`. Nothing
 * here throws on a per-product problem — the caller collects across all nine
 * so one run names every broken file rather than the alphabetically first.
 */
export function readProductInput(root, repoDir) {
  const path = join(root, repoDir, PRODUCT_YAML_RELPATH);
  const problems = [];
  if (!existsSync(path)) {
    return { ok: false, product: repoDir, repo_dir: repoDir, path, problems: [{ product: repoDir, detail: `no ${PRODUCT_YAML_RELPATH} at ${path}` }] };
  }

  const doc = parseYaml(readFileSync(path, 'utf8')) ?? {};
  const productId = doc.product_id ?? repoDir.toLowerCase();

  // `key in doc` is load-bearing: YAML `first_published: null` parses to null
  // AND is present. "Present and null" is a known unknown with a registered
  // reason code; "absent" is an unknown unknown and is a hard error.
  if (!('store_item_status' in doc)) {
    problems.push({
      product: productId,
      detail:
        'no `store_item_status` key. ABSENT is not `!= published` — refusing to emit ' +
        '`not_applicable/not_published` for a product whose store state is unknown (APP-86)',
    });
  } else if (!STORE_ITEM_STATUS.includes(doc.store_item_status)) {
    problems.push({
      product: productId,
      detail:
        `store_item_status ${JSON.stringify(doc.store_item_status)} is outside ` +
        `[${STORE_ITEM_STATUS.join(', ')}] — refusing to treat an unrecognised value as not-published`,
    });
  }

  if (!('first_published' in doc)) {
    problems.push({
      product: productId,
      detail:
        'no `first_published` key. The day-30/60/90 clock origin is a known unknown ' +
        '(`first_published: null`, reason_code first_published_null) or it is a hard error — never a default',
    });
  } else if (doc.first_published != null && Number.isNaN(Date.parse(doc.first_published))) {
    problems.push({
      product: productId,
      detail: `first_published ${JSON.stringify(doc.first_published)} is not a parseable date`,
    });
  }

  const platforms = Array.isArray(doc.platform) ? doc.platform : doc.platform ? [doc.platform] : [];
  if (platforms.length === 0) {
    problems.push({ product: productId, detail: 'no `platform` — no rule set can be selected' });
  }

  if (problems.length > 0) return { ok: false, product: productId, repo_dir: repoDir, path, problems };

  return {
    ok: true,
    product: productId,
    repo_dir: repoDir,
    path,
    platforms,
    store_item_status: doc.store_item_status,
    first_published: doc.first_published ?? null,
    security_classification: doc.security_classification ?? null,
    store_ids: doc.store_ids ?? {},
  };
}

/**
 * Load all products, in declared order, WITHOUT throwing.
 *
 * Each element keeps its `ok` flag, and the evaluator turns `ok: false` into
 * an `input_error` record for THAT product. The fail-closed property APP-86
 * asked for is per-product, not per-run:
 *
 *   - the named product gets NO verdict — not `not_applicable`, not a reason
 *     code, not a default;
 *   - the run exits non-zero, so a broken product.yaml cannot pass silently;
 *   - every other product is still evaluated.
 *
 * Aborting the whole run instead was tried first and is wrong. InvTrack's two
 * missing keys are parked behind a founder edit (APP-86, `autonomy: L0`), so a
 * whole-run abort makes the evaluator produce nothing at all until a human gets
 * to a two-line metadata change — the eight verdicts it CAN justify are not
 * made safer by being withheld. What APP-86 forbids is a confident wrong
 * verdict for the product whose inputs are unknown, and an `input_error` row
 * naming the product and the absent keys is louder than `not_applicable` ever
 * was. Allocation is a separate matter and IS withheld portfolio-wide (see
 * portfolio-allocation.mjs): a share-of-pool calculation over an incomplete
 * portfolio is arithmetic on a set nobody can enumerate.
 */
export function loadProductInputs(root, repoDirs = PRODUCT_REPOS) {
  return repoDirs.map((d) => readProductInput(root, d));
}
