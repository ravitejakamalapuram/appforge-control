import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  QUOTA_PAUSE_ERROR_CODE,
  classifyRecoveryDisposition,
  isQuotaPauseCollateral,
  selectQuotaPauseCollateral,
  partitionRecoveryCollateral,
  formatCollateralReport,
  formatBoardOnlyReport,
  pausedRunIdsFromState,
} from '../lib/quota-pause-collateral.mjs';

const OWNER = '3cba1fb3-21e1-4851-832b-95de5247bff1';

// Shaped from the real APP-42 recovery action observed on 2026-09-29.
function collateralIssue(overrides = {}) {
  const { action: actionOverrides, evidence: evidenceOverrides, ...issueOverrides } = overrides;
  return {
    id: 'issue-1',
    identifier: 'APP-42',
    title: 'Store-metrics ingest',
    status: 'blocked',
    assigneeAgentId: OWNER,
    checkoutRunId: null,
    executionRunId: null,
    unresolvedBlockerCount: 0,
    activeRecoveryAction: {
      id: 'action-1',
      status: 'active',
      cause: 'stranded_assigned_issue',
      ownerType: 'board',
      returnOwnerAgentId: OWNER,
      createdAt: '2026-09-29T06:23:01.802Z',
      evidence: {
        latestRunId: '5b816ba5-0100-4331-88f7-394e691bdef6',
        latestRunStatus: 'cancelled',
        latestRunErrorCode: QUOTA_PAUSE_ERROR_CODE,
        ...evidenceOverrides,
      },
      ...actionOverrides,
    },
    ...issueOverrides,
  };
}

test('matches a blocked issue whose recovery action names a pause cancellation', () => {
  assert.equal(isQuotaPauseCollateral(collateralIssue()), true);
});

test('ignores an issue that is not blocked', () => {
  assert.equal(isQuotaPauseCollateral(collateralIssue({ status: 'in_progress' })), false);
});

test('ignores an already-resolved recovery action', () => {
  assert.equal(isQuotaPauseCollateral(collateralIssue({ action: { status: 'resolved' } })), false);
});

test('ignores a cause the sweep did classify', () => {
  assert.equal(isQuotaPauseCollateral(collateralIssue({ action: { cause: 'provider_quota' } })), false);
});

test('ignores a run that failed for a reason other than the pause', () => {
  // APP-122's real action: max_turns_exhausted, a genuine stranding.
  const issue = collateralIssue({
    evidence: { latestRunStatus: 'failed', latestRunErrorCode: 'max_turns_exhausted' },
  });
  assert.equal(isQuotaPauseCollateral(issue), false);
});

test('ignores an issue that also carries a real dependency hold', () => {
  assert.equal(isQuotaPauseCollateral(collateralIssue({ unresolvedBlockerCount: 1 })), false);
});

test('ignores an issue with no recovery action at all', () => {
  assert.equal(isQuotaPauseCollateral(collateralIssue({ activeRecoveryAction: null })), false);
});

test('narrows to our own paused runs when state supplies them', () => {
  const issue = collateralIssue();
  const ours = new Set(['5b816ba5-0100-4331-88f7-394e691bdef6']);
  const theirs = new Set(['some-operator-pause']);
  assert.equal(isQuotaPauseCollateral(issue, { pausedRunIds: ours }), true);
  assert.equal(isQuotaPauseCollateral(issue, { pausedRunIds: theirs }), false);
  // An empty set means "we have no attribution", not "nothing matches".
  assert.equal(isQuotaPauseCollateral(issue, { pausedRunIds: new Set() }), true);
});

test('selects and sorts collateral newest recovery action first', () => {
  const older = collateralIssue({
    id: 'issue-old',
    identifier: 'APP-1',
    action: { id: 'action-old', createdAt: '2026-09-29T01:00:00.000Z' },
  });
  const newer = collateralIssue({
    id: 'issue-new',
    identifier: 'APP-2',
    action: { id: 'action-new', createdAt: '2026-09-29T07:00:00.000Z' },
  });
  const genuine = collateralIssue({
    id: 'issue-genuine',
    identifier: 'APP-3',
    evidence: { latestRunStatus: 'failed', latestRunErrorCode: 'max_turns_exhausted' },
  });

  const selected = selectQuotaPauseCollateral([older, newer, genuine]);
  assert.deepEqual(selected.map((e) => e.identifier), ['APP-2', 'APP-1']);
  assert.equal(selected[0].recoveryActionId, 'action-new');
  assert.equal(selected[0].pausedRunId, '5b816ba5-0100-4331-88f7-394e691bdef6');
});

test('report names every collateral issue and its clearing path', () => {
  const lines = formatCollateralReport(selectQuotaPauseCollateral([collateralIssue()]), {
    agentName: 'CTO',
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /COLLATERAL 1 issue\(s\) agent=CTO/);
  assert.match(lines[0], /clear-my-recovery-collateral/);
  assert.match(lines[1], /APP-42/);
  assert.match(lines[1], /action-1/);
});

test('report is explicit when there is no collateral', () => {
  const lines = formatCollateralReport([], { agentName: 'CTO' });
  assert.deepEqual(lines, [
    'COLLATERAL none agent=CTO (no blocked issue traces to a pause cancellation)',
  ]);
});

test('paused run ids come from the watchdog own handled-run trail', () => {
  const state = {
    handledRunIds: {
      'run-quota': { action: 'quota', at: '2026-09-29T06:00:00.000Z' },
      'run-transient': { action: 'transient', at: '2026-09-29T06:00:00.000Z' },
      'run-success': { action: 'succeeded', at: '2026-09-29T06:00:00.000Z' },
    },
  };
  assert.deepEqual([...pausedRunIdsFromState(state)].sort(), ['run-quota', 'run-transient']);
  assert.deepEqual([...pausedRunIdsFromState({})], []);
  assert.deepEqual([...pausedRunIdsFromState(undefined)], []);
});

// -- APP-164: authority and cause boundaries -------------------------------

test('an execution-reconciliation cause is never ours to dispose of', () => {
  // These are the incidents where a provider may have taken an unverified
  // external action. Clearing one means attesting to a dead run's outcome.
  for (const cause of [
    'legacy_execution_requires_reconciliation',
    'uncertain_external_action',
    'native_provider_terminal_failed',
  ]) {
    const issue = collateralIssue({ action: { cause } });
    assert.equal(classifyRecoveryDisposition(issue), null, cause);
    assert.equal(isQuotaPauseCollateral(issue), false, cause);
  }
});

test('an action whose issue lost its assignee is board-only, not hand-back', () => {
  // assertSafeRecoveryHandBackGates requires assignee === returnOwner, and
  // requireRecoveryActionAuthority 403s every agent when neither matches.
  const orphan = collateralIssue({ status: 'todo', assigneeAgentId: null });
  assert.equal(classifyRecoveryDisposition(orphan), 'board_only');
  assert.equal(isQuotaPauseCollateral(orphan), false);
});

test('a reassigned issue is board-only rather than handed to the wrong owner', () => {
  const reassigned = collateralIssue({ assigneeAgentId: 'some-other-agent' });
  assert.equal(classifyRecoveryDisposition(reassigned), 'board_only');
});

test('an action with no recorded return owner is not actionable', () => {
  const noOwner = collateralIssue({ action: { returnOwnerAgentId: null } });
  assert.equal(classifyRecoveryDisposition(noOwner), null);
});

test('a live checkout or execution lock defers to the run that holds it', () => {
  // The gate rejects both with recovery_source_run_lock; skipping here turns
  // a guaranteed 409 into a log line we can explain.
  assert.equal(classifyRecoveryDisposition(collateralIssue({ checkoutRunId: 'run-x' })), null);
  assert.equal(classifyRecoveryDisposition(collateralIssue({ executionRunId: 'run-y' })), null);
});

test('hand-back is not restricted to blocked issues', () => {
  // The re-block loop can leave the action active while the status has
  // already moved on; the action is still the thing that needs clearing.
  assert.equal(classifyRecoveryDisposition(collateralIssue({ status: 'todo' })), 'hand_back');
});

test('partition separates what we may clear from what only the board may', () => {
  const mine = collateralIssue({ id: 'i1', identifier: 'APP-1' });
  const orphan = collateralIssue({
    id: 'i2',
    identifier: 'APP-2',
    status: 'todo',
    assigneeAgentId: null,
  });
  const untouchable = collateralIssue({
    id: 'i3',
    identifier: 'APP-3',
    action: { cause: 'legacy_execution_requires_reconciliation' },
  });

  const { handBack, boardOnly } = partitionRecoveryCollateral([mine, orphan, untouchable]);
  assert.deepEqual(handBack.map((e) => e.identifier), ['APP-1']);
  assert.deepEqual(boardOnly.map((e) => e.identifier), ['APP-2']);
});

test('the board-only report is silent when there is nothing orphaned', () => {
  assert.deepEqual(formatBoardOnlyReport([]), []);
});

test('the board-only report names the authority that is missing', () => {
  const orphan = collateralIssue({ id: 'i2', identifier: 'APP-2', status: 'todo', assigneeAgentId: null });
  const { boardOnly } = partitionRecoveryCollateral([orphan]);
  const lines = formatBoardOnlyReport(boardOnly, { agentName: 'CTO' });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /ORPHANED 1 recovery action\(s\) agent=CTO/);
  assert.match(lines[0], /board disposition required/);
  assert.match(lines[1], /APP-2/);
});
