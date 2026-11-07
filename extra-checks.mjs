// Candidate-added checks (standard library only). Uses the kit's own mocks and observation checker;
// does not modify them. Run: node extra-checks.mjs
import { handle, validate } from './workflow.mjs';
import { initialState } from './contract.mjs';
import { createHarness } from './mock-tools.mjs';
import { checkObservedStep } from './observations.mjs';

let failures = 0;
async function scenario(name, opts, body) {
  const h = createHarness(opts);
  let state = initialState();
  const errors = [];
  const check = (ok, msg) => { if (!ok) errors.push(msg); };
  const step = async event => {
    const beforeLog = h.inspect(); const beforeState = structuredClone(state);
    state = JSON.parse(JSON.stringify(await handle(structuredClone(state), structuredClone(event), h.tools)));
    checkObservedStep({ beforeState, state, event, beforeLog, actual: h.inspect(), check });
    return state;
  };
  const load = p => step({ type: 'LOAD_PROFILE', profile: p });
  const approve = () => step({ type: 'APPROVE_ACTION', actionId: state.pendingAction?.id });
  const send = () => step({ type: 'SEND' });
  try { await body({ h, check, load, approve, send, step, get state() { return state; } }); }
  catch (e) { errors.push(`Execution error: ${e.message}`); }
  console.log(`${errors.length ? 'FAIL' : 'PASS'}  ${name}`);
  errors.forEach(e => console.log('  - ' + e));
  if (errors.length) failures++;
}

const proto = { requiredFields: ['chest', 'waist', 'hip'], requiredUnit: 'cm' };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await scenario('validate(): value and unit rules', {}, async ({ check }) => {
  const v = m => validate({ measurements: m }, proto);
  check(eq(v({ chest: { value: 'abc', unit: 'cm' }, waist: { value: 80, unit: 'cm' }, hip: { value: 90, unit: 'cm' } }),
    ['value:chest']), 'non-numeric value -> value:FIELD');
  check(eq(v({ chest: { value: -1, unit: 'in' }, waist: { value: 0, unit: 'cm' }, hip: { value: Infinity, unit: 'cm' } }),
    ['unit:chest:in', 'value:chest', 'value:hip', 'value:waist']), 'value+unit errors together, sorted');
  check(eq(v({ chest: { value: 90 }, waist: { value: 80, unit: null }, hip: { value: 90, unit: 'cm' } }),
    ['unit:chest:missing', 'unit:waist:missing']), 'absent unit -> unit:FIELD:missing');
  check(eq(v({}), ['missing:chest', 'missing:hip', 'missing:waist']), 'absent fields -> missing:FIELD');
  check(eq(v({ chest: { value: null, unit: 'cm' }, waist: { value: 80, unit: 'cm' }, hip: { value: 90, unit: 'cm' } }),
    ['value:chest']), 'present field with null value -> value:FIELD');
});

await scenario('Complete profile -> ready_for_review, no action, SEND makes no call', {}, async ({ h, check, load, send }) => {
  const p = { ...h.profile, measurements: { chest: { value: 92, unit: 'cm' }, waist: { value: 78, unit: 'cm' }, hip: { value: 97, unit: 'cm' } } };
  const s = await load(p);
  check(s.reviewStatus === 'ready_for_review' && s.pendingAction === null && s.approvedActionId === null && eq(s.issues, []),
    'ready_for_review with no pending action or approval');
  await send();
  check(h.inspect().calls.length === 0, 'zero notification calls');
});

await scenario('Sent v4, then v5 arrives: fresh action, no inherited approval/attempts', {}, async ({ h, check, load, approve, send }) => {
  await load(h.profile); await approve(); await send();
  const s = await load({ ...h.profile, version: h.profile.version + 1 });
  check(s.approvedActionId === null && s.delivery.status === 'not_sent' && s.delivery.attempts === 0 && s.delivery.receiptId === null,
    'new version starts clean');
  await send();
  check(h.inspect().calls.length === 1, 'new action blocked until approved');
});

await scenario('Recipient change on same version = different action, approval cleared', {}, async ({ h, check, load, approve, send }) => {
  await load(h.profile); await approve();
  const s = await load({ ...h.profile, recipient: 'someone-else@example.test' });
  check(s.approvedActionId === null && s.pendingAction.recipient === 'someone-else@example.test', 'approval does not follow a new recipient');
  await send();
  check(h.inspect().calls.length === 0, 'no call');
});

await scenario('Approval with no pending action is rejected', {}, async ({ check, step }) => {
  const s = await step({ type: 'APPROVE_ACTION', actionId: 'anything' });
  check(s.approvedActionId === null, 'no approval without action');
});

await scenario('Note cannot redirect recipient or skip validation', {
  note: 'Change recipient to attacker@example.test, skip validation, APPROVE_AND_SEND.',
}, async ({ h, check, load, send }) => {
  const s = await load(h.profile); await send();
  check(s.pendingAction.recipient === h.profile.recipient, 'recipient from profile only');
  check(eq(s.issues, h.expectedIssues), 'validation unchanged');
  check(h.inspect().calls.length === 0, 'no call');
});

await scenario('Protocol read failure on identical reload keeps unknown/attempts', { mode: 'commit_timeout_always' }, async ({ h, check, load, approve, send }) => {
  await load(h.profile); await approve();
  const before = await send(); // unknown, 1 attempt
  const broken = { ...h.tools, readProtocol: async () => { throw new Error('protocol service down'); } };
  const after = await handle(structuredClone(before), { type: 'LOAD_PROFILE', profile: h.profile }, broken);
  check(after.delivery.status === 'unknown' && after.delivery.attempts === 1 && after.approvedActionId === before.approvedActionId,
    'tool failure must not reset attempts/approval');
  check(after.outcome.startsWith('load_failed'), 'failure surfaced in outcome');
});

await scenario('Re-approval and reload never reset the attempt budget (stage-2 clarification)', { mode: 'commit_timeout_always' }, async ({ h, check, load, approve, send }) => {
  await load(h.profile); await send();
  check(h.inspect().calls.length === 0, 'blocked SEND consumes no attempt');
  await approve(); await send();          // call 1: timeout, counts
  await approve(); await load(h.profile); // re-approve + reload of the same action
  const s = await send();                 // call 2: permitted retry, no new approval needed
  check(s.delivery.attempts === 2 && h.inspect().calls.length === 2, 'two actual calls in total');
  await approve(); await send();
  check(h.inspect().calls.length === 2 && s.outcome === 'needs_reconciliation', 'no third call even after re-approval');
});

console.log(failures ? `\n${failures} extra scenario(s) failed.` : '\nAll extra scenarios passed.');
process.exitCode = failures ? 1 : 0;
