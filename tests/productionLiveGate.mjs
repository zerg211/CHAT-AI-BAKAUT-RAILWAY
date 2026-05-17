export function requireProductionLiveApproval(options = {}) {
  const {
    scriptName = 'production live test',
    allowFixedReplay = false
  } = options;
  const approved = process.env.ALLOW_PRODUCTION_LIVE_TESTS === '1'
    && process.env.FINAL_RELEASE_LIVE_GATE === '1';
  const fixedReplayApproved = allowFixedReplay || process.env.ALLOW_FIXED_PRODUCTION_REPLAY === '1';

  if (approved && fixedReplayApproved) return;

  console.error(JSON.stringify({
    ok: false,
    scriptName,
    stage: 'production_live_gate',
    reason: approved
      ? 'fixed_replay_not_approved'
      : 'production_live_tests_not_explicitly_approved',
    requiredEnv: {
      ALLOW_PRODUCTION_LIVE_TESTS: '1',
      FINAL_RELEASE_LIVE_GATE: '1',
      ALLOW_FIXED_PRODUCTION_REPLAY: allowFixedReplay ? undefined : '1 for old fixed replay scripts only'
    },
    policy: 'Production dialogs are reserved for the final pre-launch gate. They must be varied, non-repeating, and manually audited against widget output plus admin metadata.'
  }, null, 2));
  process.exit(2);
}
