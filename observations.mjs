import { isDeepStrictEqual } from 'node:util';
import { makeActionId } from './contract.mjs';

// Observe tool-owned records and public state, independently of claimed summaries.
// This helper checks the published contract; it is not an execution sandbox.
export function checkObservedStep({ beforeState, state, event, beforeLog, actual, check }) {
  const newCalls = actual.calls.slice(beforeLog.calls.length);
  check(newCalls.length <= (event.type === 'SEND' ? 1 : 0),
    'Only SEND may call notify, at most once per event.');
  const expectedProfile = event.type === 'LOAD_PROFILE' ? event.profile : beforeState.currentProfile;
  check(isDeepStrictEqual(state.currentProfile, JSON.parse(JSON.stringify(expectedProfile))),
    'Preserve the supplied profile snapshot exactly; do not invent or convert values.');

  if (event.type !== 'LOAD_PROFILE') {
    check(isDeepStrictEqual(state.pendingAction, beforeState.pendingAction),
      'Approval and SEND must preserve the exact pending action.');
  }
  for (const call of newCalls) {
    const approved = beforeState.pendingAction;
    check(Boolean(approved && beforeState.approvedActionId === approved.id),
      'Every notification call requires matching prior human approval.');
    check(call.idempotencyKey === approved?.id && call.recipient === approved?.recipient &&
      call.text === approved?.text,
      'The actual notification key, recipient and text must equal the approved action.');
  }

  const action = state.pendingAction;
  if (action) {
    check(action.kind === 'SEND_CLARIFICATION' && action.id === makeActionId(action),
      'Use SEND_CLARIFICATION and the canonical action identity.');
    check(action.profileId === state.currentProfile?.id &&
      action.profileVersion === state.currentProfile?.version &&
      action.recipient === state.currentProfile?.recipient,
      'The action must address the current profile/version and its recipient.');
    const draftWasRequested = actual.toolCalls.some(call => call.tool === 'draftClarification' &&
      call.profileId === action.profileId && call.profileVersion === action.profileVersion &&
      isDeepStrictEqual(call.issues, state.issues));
    check(draftWasRequested, 'Use the supplied drafting tool for this profile/version and its validated issues.');
    check(action.text === `Please clarify ${action.profileId} version ${action.profileVersion}: ${state.issues.join(', ')}.`,
      'Preserve the exact drafting tool output as the action text.');
    const attempts = actual.calls.filter(call => call.idempotencyKey === action.id).length;
    check(state.delivery.attempts === attempts && attempts <= 2,
      'Record the actual attempt count for this action, with a maximum of two.');
  }
}
