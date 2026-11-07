import { createHash } from 'node:crypto';

export const MAX_ATTEMPTS = 2;

export function initialState() {
  return {
    currentProfile: null,
    currentProtocol: null,
    issues: [],
    reviewStatus: 'unreviewed',
    pendingAction: null,
    approvedActionId: null,
    delivery: { status: 'not_sent', attempts: 0, receiptId: null },
    outcome: 'initial',
  };
}

// The action ID is also the notification idempotency key.
// protocolRevision is optional in the baseline and required in the later change.
export function makeActionId(action) {
  const identity = [
    action.kind, action.profileId, action.profileVersion,
    action.recipient, action.text,
  ];
  if (action.protocolRevision !== undefined) identity.push(action.protocolRevision);
  return 'action-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
}

export function stateView(state) {
  return {
    version: state.currentProfile?.version ?? null,
    protocolRevision: state.currentProtocol?.revision ?? null,
    issues: state.issues,
    reviewStatus: state.reviewStatus,
    actionId: state.pendingAction?.id ?? null,
    approved: Boolean(state.pendingAction && state.approvedActionId === state.pendingAction.id),
    delivery: state.delivery?.status,
    attempts: state.delivery?.attempts,
    receiptId: state.delivery?.receiptId,
    outcome: state.outcome,
  };
}
