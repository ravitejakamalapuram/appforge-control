import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

import { createManifestEntry } from '../lib/metrics-manifest.mjs';
import {
  PortfolioConfigError, STORE_ITEM_STATUS, loadPortfolio, validatePortfolio,
} from '../lib/portfolio-config.mjs';
import { ClauseParseError, compileRules, parseClause } from '../lib/portfolio-clauses.mjs';
import { loadProductInputs, readProductInput } from '../lib/portfolio-products.mjs';
import { evaluatePortfolio, fixableBy, rulesForPlatform } from '../lib/portfolio-eval.mjs';
import { computeAllocation, scoreProduct } from '../lib/portfolio-allocation.mjs';

const CONFIG = fileURLToPath(new URL('../../config/portfolio.yaml', import.meta.url));

// The nine product repos are siblings of this one, not vendored into it. Where
// they live is machine-specific, so it is resolved, not hardcoded; and the two
// tests that read them SKIP rather than fail where they are absent (CI clones
// appforge-control alone). Skipping is honest here: those tests assert a fact
// about files this repo does not own.
const PRODUCTS_ROOT = process.env.APPFORGE_PRODUCTS_ROOT
  ?? join(homedir(), 'git-personal');
const haveProductRepos = existsSync(join(PRODUCTS_ROOT, 'InvTrack', '.appforge', 'product.yaml'));
const REAL = loadPortfolio(CONFIG);

function scratch() {
  return mkdtempSync(join(tmpdir(), 'portfolio-test-'));
}

function writeProduct(root, dir, body) {
  mkdirSync(join(root, dir, '.appforge'), { recursive: true });
  writeFileSync(join(root, dir, '.appforge', 'product.yaml'), body);
}

function manifestWith(entries) {
  return entries;
}

// ---------------------------------------------------------------------------
// config: the section 5a structural invariants, fail-closed
// ---------------------------------------------------------------------------

test('the real config passes every structural invariant', () => {
  assert.deepEqual(validatePortfolio(REAL), []);
});

test('a store-only SUNSET rule is refused at load — the whole point of D2 rider 1', () => {
  const doc = loadPortfolio(CONFIG);
  doc.rules.push({
    id: 'sunset_store_only', outcome: 'SUNSET', platforms: ['chrome'],
    when_all: ['cws_weekly_users < 10'], requires: ['cws_weekly_users'],
  });
  const failures = validatePortfolio(doc);
  const ids = failures.map((f) => f.id);
  assert.ok(ids.includes('no_store_only_sunset_or_scale'), 'store-only SUNSET must fail the invariant');
});

test('a default_outcome is refused', () => {
  const doc = loadPortfolio(CONFIG);
  doc.default_outcome = 'CONTINUE';
  assert.ok(validatePortfolio(doc).some((f) => f.id === 'no_default_outcome'));
});

test('dropping retention_d30.never_proxy is refused', () => {
  const doc = loadPortfolio(CONFIG);
  doc.metrics.retention_d30.never_proxy = false;
  assert.ok(validatePortfolio(doc).some((f) => f.id === 'retention_d30_never_proxied'));
});

test('declaring a proxy for retention_d30 anywhere is refused', () => {
  const doc = loadPortfolio(CONFIG);
  doc.allocation.proxies.retention_d30 = { proxy: true, proxies_for: 'retention' };
  assert.ok(validatePortfolio(doc).some((f) => f.id === 'retention_d30_never_proxied'));
});

test('aliasing two forbidden-pair metrics onto one source field is refused', () => {
  const doc = loadPortfolio(CONFIG);
  // Point true_wau at exactly the CWS dashboard field cws_weekly_users uses.
  doc.metrics.true_wau.source = 'cws_dashboard_export';
  doc.metrics.true_wau.field = 'Weekly users';
  const failures = validatePortfolio(doc);
  assert.ok(failures.some((f) => f.id === 'no_forbidden_alias_in_any_rule'),
    'cws_weekly_users must never resolve as true_wau');
});

test('a metric without an origin is refused', () => {
  const doc = loadPortfolio(CONFIG);
  delete doc.metrics.cws_installs.origin;
  assert.ok(validatePortfolio(doc).some((f) => f.id === 'every_metric_declares_origin'));
});

test('loadPortfolio throws rather than returning a config that failed an invariant', () => {
  const root = scratch();
  const bad = join(root, 'bad.yaml');
  const doc = parseYaml(readFileSync(CONFIG, 'utf8'));
  doc.default_outcome = 'CONTINUE';
  writeFileSync(bad, JSON.stringify(doc)); // JSON is valid YAML
  assert.throws(() => loadPortfolio(bad), PortfolioConfigError);
});

test('STORE_ITEM_STATUS matches the enum the config states in its comment', () => {
  const text = readFileSync(CONFIG, 'utf8');
  const m = /store_item_status ∈ \[([^\]]+)\]/.exec(text);
  assert.ok(m, 'config must still state the enum');
  const fromConfig = m[1].split(',').map((s) => s.trim());
  assert.deepEqual([...STORE_ITEM_STATUS], fromConfig);
});

test('the verbatim notice is read from config, not embedded in code', () => {
  const text = readFileSync(CONFIG, 'utf8');
  const notice = REAL.output_contract.insufficient_data_notice.text;
  assert.ok(notice.includes('is not a freeze'));
  // The evaluator's own source must not carry a copy of the sentence.
  const src = readFileSync(fileURLToPath(new URL('../metrics-portfolio.mjs', import.meta.url)), 'utf8')
    + readFileSync(fileURLToPath(new URL('../lib/portfolio-config.mjs', import.meta.url)), 'utf8');
  assert.ok(!src.includes('is not a freeze:'), 'evaluator must not embed its own copy of the notice');
});

// ---------------------------------------------------------------------------
// clause parsing: fail closed, never "false"
// ---------------------------------------------------------------------------

test('every clause in the real config parses', () => {
  const compiled = compileRules(REAL);
  assert.equal(compiled.size, REAL.rules.length);
});

test('an unrecognised clause form throws rather than scoring false', () => {
  assert.throws(() => parseClause('cws_weekly_users is basically fine', 'r1'), ClauseParseError);
  assert.throws(() => parseClause('retention_d30 ~= 0.2', 'r1'), ClauseParseError);
});

test('the term union includes clause terms absent from `requires`', () => {
  const compiled = compileRules(REAL);
  // `scale` reads marketing_spend, which is in no `requires` list.
  assert.ok(compiled.get('scale').terms.includes('marketing_spend'));
  // `iterate_distribution_problem` reads acquisition_weak, likewise.
  assert.ok(compiled.get('iterate_distribution_problem').terms.includes('acquisition_weak'));
});

// ---------------------------------------------------------------------------
// APP-86: absent, out-of-enum, and present-not-published are three inputs
// ---------------------------------------------------------------------------

const PUBLISHED_YAML = `product_id: fixture\nplatform: [chrome]\nstore_item_status: published\nfirst_published: "2026-01-01"\nsecurity_classification: low\n`;

test('an ABSENT store_item_status is a hard error, never not_published', () => {
  const root = scratch();
  writeProduct(root, 'fixture', 'product_id: fixture\nplatform: [chrome]\nfirst_published: null\n');
  const r = readProductInput(root, 'fixture');
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /no `store_item_status` key/.test(p.detail)));
  // and specifically NOT a verdict
  assert.ok(!JSON.stringify(r).includes('"outcome"'));
});

test('an ABSENT first_published is a hard error, never a default', () => {
  const root = scratch();
  writeProduct(root, 'fixture', 'product_id: fixture\nplatform: [chrome]\nstore_item_status: published\n');
  const r = readProductInput(root, 'fixture');
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /no `first_published` key/.test(p.detail)));
});

test('an out-of-enum store_item_status is a hard error, not silently not_published', () => {
  const root = scratch();
  writeProduct(root, 'fixture', 'product_id: fixture\nplatform: [chrome]\nstore_item_status: live\nfirst_published: null\n');
  const r = readProductInput(root, 'fixture');
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /outside \[published/.test(p.detail)));
});

test('a PRESENT, in-enum, non-published status is the only route to not_published', () => {
  const root = scratch();
  writeProduct(root, 'fixture', 'product_id: fixture\nplatform: [chrome]\nstore_item_status: draft\nfirst_published: null\n');
  const r = readProductInput(root, 'fixture');
  assert.equal(r.ok, true);
  const [res] = evaluatePortfolio({ doc: REAL, manifest: [], products: [r] });
  assert.equal(res.outcome, 'not_applicable');
  assert.deepEqual(res.reason_codes, ['not_published']);
});

test('one unusable product.yaml costs that product its verdict, not the others theirs', () => {
  const root = scratch();
  writeProduct(root, 'good', PUBLISHED_YAML);
  writeProduct(root, 'bad', 'product_id: bad\nplatform: [chrome]\n');
  const inputs = loadProductInputs(root, ['good', 'bad']);
  const results = evaluatePortfolio({ doc: REAL, manifest: [], products: inputs, now: new Date('2026-09-29') });

  // order is the declared order, and one row per product either way
  assert.equal(results.length, 2);
  assert.equal(results[1].product, 'bad', 'the broken product keeps its declared position');

  const bad = results[1];
  assert.equal(bad.outcome, 'input_error');
  assert.equal(bad.input_problems.length, 2, 'both absent keys are named, not just the first');
  assert.deepEqual(bad.reason_codes, [], 'input_error carries no reason code — there is no verdict to explain');

  const good = results[0];
  assert.notEqual(good.outcome, 'input_error');
  assert.ok(REAL.outcomes.includes(good.outcome), 'the healthy product still gets a real outcome');
});

test('input_error is not one of the config\'s outcomes, so it cannot be read as one', () => {
  assert.equal(REAL.outcomes.includes('input_error'), false);
  assert.equal('input_error' in REAL.reason_codes, false);
});

test('a product in input_error withholds the growth pool for the whole portfolio', () => {
  const results = [
    { product: 'ok', outcome: 'not_applicable' },
    { product: 'broken', outcome: 'input_error' },
  ];
  // `ok` is given FULL §22 coverage, so the only thing that can withhold the
  // pool here is the unevaluable product.
  const a = computeAllocation({
    doc: REAL, results,
    terms: { ok: { contribution_trend: 1, wau_growth: 1, retention_d30: 1, strategic: 1, maintenance_burden: 0 } },
  });
  assert.equal(a.coverage, 1, 'coverage is computed over evaluable products only');
  assert.equal(a.growth_pool, 'withheld_entirely');
  assert.ok(a.withheld.some((w) => w.reason === 'portfolio_not_enumerable'));
  assert.deepEqual(a.not_evaluable, ['broken']);
  assert.equal(a.per_product.length, 1, 'the unevaluable product is not scored');
});

test('the live InvTrack product.yaml is refused by name (APP-86 is still open)', { skip: haveProductRepos ? false : 'product repos not present' }, () => {
  const r = readProductInput(PRODUCTS_ROOT, 'InvTrack');
  assert.equal(r.ok, false, 'InvTrack still lacks both keys; when APP-86 lands this test flips');
  assert.equal(r.problems[0].product, 'invtrack');

  // and specifically NOT the verdict a literal reading of resolution.order
  // step 1 would produce for it. The Play listing is live with real users.
  const [res] = evaluatePortfolio({
    doc: REAL, manifest: [], products: [r], now: new Date('2026-09-29'),
  });
  assert.equal(res.outcome, 'input_error');
  assert.notEqual(res.outcome, 'not_applicable');
  assert.equal(res.reason_codes.includes('not_published'), false);
});

// ---------------------------------------------------------------------------
// resolution order
// ---------------------------------------------------------------------------

test('first_published: null yields not_applicable, never an outcome', () => {
  const root = scratch();
  writeProduct(root, 'p', 'product_id: p\nplatform: [chrome]\nstore_item_status: published\nfirst_published: null\n');
  const [res] = evaluatePortfolio({ doc: REAL, manifest: [], products: loadProductInputs(root, ['p']) });
  assert.equal(res.outcome, 'not_applicable');
  assert.deepEqual(res.reason_codes, ['first_published_null']);
  assert.equal(res.rules.length, 0, 'no rule is scored once the clock has no origin');
});

test('not_published stops before first_published is even read', () => {
  const root = scratch();
  writeProduct(root, 'p', 'product_id: p\nplatform: [chrome]\nstore_item_status: unlisted\nfirst_published: "2026-01-01"\n');
  const [res] = evaluatePortfolio({ doc: REAL, manifest: [], products: loadProductInputs(root, ['p']) });
  assert.equal(res.outcome, 'not_applicable');
  assert.deepEqual(res.reason_codes, ['not_published']);
});

test('a published product with a clock and no data is insufficient_data, not CONTINUE', () => {
  const root = scratch();
  writeProduct(root, 'p', PUBLISHED_YAML);
  const [res] = evaluatePortfolio({
    doc: REAL, manifest: [], products: loadProductInputs(root, ['fixture'].map(() => 'p')),
    now: new Date('2026-09-29'),
  });
  assert.equal(res.outcome, 'insufficient_data');
  assert.notEqual(res.outcome, 'CONTINUE');
  assert.notEqual(res.outcome, 'not_applicable');
  assert.ok(res.blocking.length > 0);
  assert.ok(res.reason_codes.length > 0, 'every insufficient_data carries >=1 reason code');
});

test('every emitted reason code is registered in the config', () => {
  const root = scratch();
  writeProduct(root, 'p', PUBLISHED_YAML);
  writeProduct(root, 'a', 'product_id: a\nplatform: [android]\nstore_item_status: published\nfirst_published: "2026-01-01"\n');
  const results = evaluatePortfolio({
    doc: REAL, manifest: [], products: loadProductInputs(root, ['p', 'a']), now: new Date('2026-09-29'),
  });
  for (const r of results) {
    for (const rc of r.reason_codes) {
      assert.ok(rc in REAL.reason_codes, `reason code \`${rc}\` is not in the registry`);
    }
  }
});

test('no product can reach SCALE or SUNSET on store data alone', () => {
  const root = scratch();
  writeProduct(root, 'p', PUBLISHED_YAML);
  // Give it every store metric, fresh and large.
  const manifest = ['cws_weekly_users', 'cws_installs', 'cws_uninstalls', 'cws_listing_page_views', 'cws_impressions']
    .map((m) => createManifestEntry({
      source: 'cws_dashboard_export', item_id: 'fixture', as_of: '2026-09-28',
      exported_at: '2026-09-28T00:00:00Z', checksum: 'x', metrics: { [m]: 100000 },
    }));
  const [res] = evaluatePortfolio({
    doc: REAL, manifest, products: loadProductInputs(root, ['p']), now: new Date('2026-09-29'),
  });
  assert.ok(!['SCALE', 'SUNSET'].includes(res.outcome), `store-only data produced ${res.outcome}`);
  assert.equal(res.outcome, 'insufficient_data');
});

// ---------------------------------------------------------------------------
// the freshness acceptance case
// ---------------------------------------------------------------------------

test('a deliberately STALE import yields insufficient_data naming the stale metric', () => {
  const root = scratch();
  writeProduct(root, 'p', PUBLISHED_YAML);
  // cws_weekly_users has max_age_days 14. Import as_of 60 days before `now`.
  const manifest = [createManifestEntry({
    source: 'cws_dashboard_export', item_id: 'fixture', as_of: '2026-07-01',
    exported_at: '2026-07-01T00:00:00Z', checksum: 'stale', metrics: { cws_weekly_users: 900 },
  })];
  const [res] = evaluatePortfolio({
    doc: REAL, manifest, products: loadProductInputs(root, ['p']), now: new Date('2026-09-29'),
  });

  assert.equal(res.outcome, 'insufficient_data', 'a stale import must never produce a verdict');
  assert.ok(res.reason_codes.includes('metric_stale'), 'metric_stale must be named');

  const day90 = res.blocking.find((b) => b.rule_id === 'sunset_day90_no_traction');
  assert.ok(day90, 'the rule requiring the stale metric must appear in the blocking list');
  const stale = day90.stale_metrics.find((s) => s.metric === 'cws_weekly_users');
  assert.ok(stale, 'the stale metric must be named');
  assert.equal(stale.as_of, '2026-07-01', 'the stale reading reports its as_of');
  assert.ok(stale.age_days > stale.max_age_days);

  // and the withheld value must not have leaked into any verdict
  assert.ok(!JSON.stringify(res.rules.map((r) => r.values ?? {})).includes('900'));
});

test('a missing metric is never 0, never false, never "not fired"', () => {
  const root = scratch();
  writeProduct(root, 'p', PUBLISHED_YAML);
  const [res] = evaluatePortfolio({
    doc: REAL, manifest: [], products: loadProductInputs(root, ['p']), now: new Date('2026-09-29'),
  });
  // `pause` requires contribution <= 0. If a missing contribution defaulted
  // to 0 the clause would be satisfied. It must be UNDECIDABLE instead.
  const pause = res.rules.find((r) => r.rule_id === 'pause');
  assert.equal(pause.disposition, 'UNDECIDABLE');
  assert.ok(pause.blocking.some((b) => b.term === 'contribution'));
});

test('insufficient_data reports measurability class and fixable_by for every blocker', () => {
  const root = scratch();
  writeProduct(root, 'p', PUBLISHED_YAML);
  const [res] = evaluatePortfolio({
    doc: REAL, manifest: [], products: loadProductInputs(root, ['p']), now: new Date('2026-09-29'),
  });
  const allowed = new Set(['store_ingest', 'telemetry', 'scale', 'build', 'nothing']);
  for (const b of res.blocking) {
    for (const i of b.inputs) {
      assert.ok(allowed.has(i.fixable_by), `fixable_by ${i.fixable_by} is outside the declared enum`);
      assert.ok(i.reason_code in REAL.reason_codes);
    }
  }
});

test('retention and activation report fixable_by=scale, not telemetry', () => {
  // Shipping telemetry does not make them measurable at n=3-5; it makes them
  // measurable once the base is large enough. Reporting "telemetry" would
  // send someone to build the wrong fix.
  assert.equal(fixableBy(REAL.metrics.retention_d30), 'scale');
  assert.equal(fixableBy(REAL.metrics.activation), 'scale');
  assert.equal(fixableBy(REAL.metrics.support_cost), 'nothing');
  assert.equal(fixableBy(REAL.metrics.cws_weekly_users), 'store_ingest');
});

test('a PROPOSED_NOT_IN_PLAN definition is refused, not used', () => {
  assert.equal(REAL.definitions.acquisition_weak.status, 'PROPOSED_NOT_IN_PLAN');
  const root = scratch();
  writeProduct(root, 'p', PUBLISHED_YAML);
  const [res] = evaluatePortfolio({
    doc: REAL, manifest: [], products: loadProductInputs(root, ['p']), now: new Date('2026-09-29'),
  });
  const iterate = res.rules.find((r) => r.rule_id === 'iterate_distribution_problem');
  assert.equal(iterate.disposition, 'UNDECIDABLE');
  const aw = iterate.blocking.find((b) => b.term === 'acquisition_weak');
  assert.ok(aw, 'acquisition_weak must appear as a blocker');
  assert.equal(aw.reason_code, 'thresholds_not_set');
});

test('marketing_spend, declared nowhere, blocks SCALE rather than reading as 0', () => {
  const root = scratch();
  writeProduct(root, 'p', PUBLISHED_YAML);
  const [res] = evaluatePortfolio({
    doc: REAL, manifest: [], products: loadProductInputs(root, ['p']), now: new Date('2026-09-29'),
  });
  const scale = res.rules.find((r) => r.rule_id === 'scale');
  assert.ok(scale.blocking.some((b) => b.term === 'marketing_spend' && b.status === 'no_contract'));
});

// ---------------------------------------------------------------------------
// D5: Android gets its own rule set, never an aliased threshold
// ---------------------------------------------------------------------------

test('Android WAU-written rules return play_wau_unavailable, not a borrowed threshold', () => {
  const root = scratch();
  writeProduct(root, 'a', 'product_id: a\nplatform: [android]\nstore_item_status: published\nfirst_published: "2026-01-01"\n');
  const [res] = evaluatePortfolio({
    doc: REAL, manifest: [], products: loadProductInputs(root, ['a']), now: new Date('2026-09-29'),
  });
  assert.equal(res.outcome, 'insufficient_data');
  assert.ok(res.reason_codes.includes('play_wau_unavailable'));
  for (const id of ['sunset_day90_no_traction', 'scale', 'pause']) {
    const r = res.rules.find((x) => x.rule_id === id);
    assert.ok(r, `${id} must appear for android`);
    assert.equal(r.disposition, 'UNDECIDABLE');
    assert.ok(r.reason_codes.includes('play_wau_unavailable'));
  }
});

test('an android-claimed rule in neither android list is reported, not silently skipped', () => {
  const set = rulesForPlatform(REAL, 'android');
  const ids = new Set([...set.run, ...set.forced.map((f) => f.rule_id)]);
  const claimed = REAL.rules.filter((r) => r.platforms.includes('android')).map((r) => r.id);
  for (const id of claimed) assert.ok(ids.has(id), `${id} claims android but appears nowhere in the android set`);
  assert.ok(set.forced.some((f) => f.reason_code === 'thresholds_not_set'));
});

// ---------------------------------------------------------------------------
// D3: allocation renormalisation
// ---------------------------------------------------------------------------

test('an unrealised term is dropped from the score, never defaulted to 0', () => {
  // contribution_trend 0.4 realised at 0.5; everything else unrealised.
  const s = scoreProduct(REAL, 'p', { contribution_trend: 0.5 });
  assert.equal(s.coverage, 0.4);
  assert.equal(s.score, 0.5, 'renormalised over realised weight, not diluted by absent terms');
  // A 0-default would have produced 0.4*0.5 = 0.2.
  assert.notEqual(s.score, 0.2);
});

test('maintenance_burden enters negatively and is stamped as a declared proxy', () => {
  const s = scoreProduct(REAL, 'p', { contribution_trend: 1, maintenance_burden: 1 });
  assert.equal(s.coverage, 0.5);
  assert.equal(s.score, (0.4 * 1 + 0.1 * -1) / 0.5);
  const px = s.proxies_used.find((p) => p.term === 'maintenance_burden');
  assert.ok(px, 'the proxy must be stamped on the score');
  assert.equal(px.excludes, 'founder_hours');
});

test('every score carries its coverage stamp', () => {
  const s = scoreProduct(REAL, 'p', { contribution_trend: 0.5, strategic: 1 });
  assert.equal(typeof s.coverage, 'number');
  assert.ok('coverage' in s);
});

test('below the 0.7 floor the growth pool is withheld ENTIRELY, not scaled', () => {
  const results = [{ product: 'p' }, { product: 'q' }];
  const alloc = computeAllocation({
    doc: REAL, results,
    terms: { p: { contribution_trend: 1, strategic: 1, maintenance_burden: 0.5 }, q: { contribution_trend: 1, strategic: 1 } },
  });
  assert.ok(alloc.coverage < REAL.allocation.coverage.floor);
  assert.equal(alloc.growth_pool, 'withheld_entirely');
  const notice = alloc.withheld.find((w) => w.reason === 'coverage_below_floor').notice;
  assert.ok(notice.startsWith('allocation_withheld: coverage='));
  assert.ok(notice.includes(alloc.coverage.toFixed(2)));
  assert.ok(notice.includes('not a failure of the allocation script'));
});

test('the portfolio coverage stamp is the MINIMUM across scored products', () => {
  const alloc = computeAllocation({
    doc: REAL, results: [{ product: 'p' }, { product: 'q' }],
    terms: { p: { contribution_trend: 1, wau_growth: 1, retention_d30: 1, strategic: 1 }, q: { strategic: 1 } },
  });
  assert.equal(alloc.coverage, 0.1);
});

test('at full coverage the pool is allocated', () => {
  const full = { contribution_trend: 1, wau_growth: 1, retention_d30: 1, strategic: 1, maintenance_burden: 0 };
  const alloc = computeAllocation({ doc: REAL, results: [{ product: 'p' }], terms: { p: full } });
  assert.equal(alloc.coverage, 1);
  assert.equal(alloc.growth_pool, 'allocated');
  assert.equal(alloc.withheld.length, 0);
});

// ---------------------------------------------------------------------------
// first-run check against the config's own §10 fixture
// ---------------------------------------------------------------------------

test('the first run reproduces config §10, product for product', { skip: haveProductRepos ? false : 'product repos not present' }, () => {
  const root = PRODUCTS_ROOT;
  const dirs = ['json-workbench', 'echokit', 'StellarTab', 'session-transfer',
    'TeluguPanchangam', 'GitaVerses', 'cors-enabler', 'TelePort', 'InvTrack'];
  const products = loadProductInputs(root, dirs);
  const results = evaluatePortfolio({ doc: REAL, manifest: [], products, now: new Date('2026-09-29') });
  assert.equal(results.length, 9, 'all nine products are reported, one row each');

  // InvTrack is the one divergence from §10, and it is deliberate. §10 predicts
  // not_applicable / first_published_null for it; APP-86 requires input_error
  // instead, because InvTrack's product.yaml carries NEITHER key and §10's own
  // prediction assumed a backfill that has not landed. Asserted explicitly so
  // the divergence is a checked fact rather than a silent mismatch.
  const invtrack = results.find((r) => r.product === 'invtrack');
  assert.equal(invtrack.outcome, 'input_error');
  assert.equal(REAL.products.invtrack.expected_outcome, 'not_applicable');

  for (const r of results.filter((x) => x.product !== 'invtrack')) {
    const expected = REAL.products[r.product];
    assert.ok(expected, `config §10 has no row for ${r.product}`);
    assert.equal(r.outcome, expected.expected_outcome, `${r.product}: outcome`);
    assert.ok(r.reason_codes.includes(expected.reason_code), `${r.product}: reason_code`);
  }
  // and nothing reached a verdict
  assert.equal(results.filter((r) => ['SCALE', 'SUNSET', 'ITERATE', 'PAUSE'].includes(r.outcome)).length, 0);
});
