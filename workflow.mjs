import { initialState, makeActionId, MAX_ATTEMPTS } from './contract.mjs';

// Clarification workflow: validate -> draft -> wait for exact approval -> bounded, idempotent send.
//
// State machine (delivery.status per exact action ID):
//   not_sent --SEND(approved)--> sent      (receipt returned)
//   not_sent --SEND(approved)--> unknown   (timeout / error / no receipt: may or may not have delivered)
//   unknown  --SEND(approved, attempts < MAX)--> sent | unknown
//   unknown  with attempts == MAX  => outcome needs_reconciliation, no further calls
//   sent is terminal for that action: no further calls.
// Action identity = makeActionId(kind, profileId, version, recipient, text). Approval, attempts and
// delivery belong to that ID: an identical reload keeps them, a different action starts fresh.

const freshDelivery = () => ({ status: 'not_sent', attempts: 0, receiptId: null });

// Rule 2. Pure function of structured protocol fields; protocol.note is never read here.
export function validate(profile, protocol) {
  const measurements = profile?.measurements ?? {};
  const issues = [];
  for (const field of protocol.requiredFields) {
    const m = measurements[field];
    if (m === null || m === undefined) {
      issues.push(`missing:${field}`);
      continue;
    }
    const value = typeof m === 'object' ? m.value : undefined;
    const unit = typeof m === 'object' ? m.unit : undefined;
    if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      issues.push(`value:${field}`);
    }
    if (unit === null || unit === undefined || unit === '') {
      issues.push(`unit:${field}:missing`);
    } else if (unit !== protocol.requiredUnit) {
      issues.push(`unit:${field}:${unit}`);
    }
  }
  return issues.sort();
}

function deriveOutcome(state) {
  if (!state.pendingAction) {
    return state.reviewStatus === 'ready_for_review' ? 'ready_for_review' : state.outcome;
  }
  const { status, attempts } = state.delivery;
  if (status === 'sent') return 'sent';
  if (status === 'unknown') {
    return attempts >= MAX_ATTEMPTS ? 'needs_reconciliation' : 'delivery_unknown_retry_allowed';
  }
  return state.approvedActionId === state.pendingAction.id ? 'approved_ready_to_send' : 'awaiting_approval';
}

async function onLoadProfile(previous, state, profile, tools) {
  const sameSnapshot = JSON.stringify(previous.currentProfile) === JSON.stringify(profile);

  let protocol, issues, text;
  try {
    protocol = await tools.readProtocol(profile.protocolId);
    if (!Array.isArray(protocol?.requiredFields) || typeof protocol.requiredUnit !== 'string') {
      throw new Error('protocol has no usable requiredFields/requiredUnit');
    }
    issues = validate(profile, protocol);
    if (issues.length > 0) {
      text = await tools.draftClarification({
        profileId: profile.id, profileVersion: profile.version, issues,
      });
    }
  } catch (error) {
    // Fail closed. For an identical snapshot keep the existing action/attempt record untouched
    // (losing it could reset the retry limit). For a new snapshot, show it but offer no sendable action.
    if (sameSnapshot) {
      state.outcome = `load_failed: ${error.message}`;
      return state;
    }
    Object.assign(state, {
      currentProfile: structuredClone(profile), currentProtocol: null, issues: [],
      reviewStatus: 'unreviewed', pendingAction: null, approvedActionId: null,
      delivery: freshDelivery(), outcome: `load_failed: ${error.message}`,
    });
    return state;
  }

  state.currentProfile = structuredClone(profile);
  state.currentProtocol = protocol; // stored as reference data only; note is never interpreted
  state.issues = issues;

  if (issues.length === 0) {
    // Ready for a designer's review. The workflow never approves the profile itself.
    Object.assign(state, {
      reviewStatus: 'ready_for_review', pendingAction: null, approvedActionId: null,
      delivery: freshDelivery(),
    });
    state.outcome = deriveOutcome(state);
    return state;
  }

  const action = {
    kind: 'SEND_CLARIFICATION', profileId: profile.id, profileVersion: profile.version,
    recipient: profile.recipient, text,
  };
  action.id = makeActionId(action);
  state.reviewStatus = 'needs_clarification';

  if (previous.pendingAction?.id === action.id) {
    // Identical action: keep approval, attempts, status and receipt (no reset of retry limit).
    state.pendingAction = structuredClone(previous.pendingAction);
    state.approvedActionId = previous.approvedActionId === action.id ? action.id : null;
    state.delivery = structuredClone(previous.delivery);
  } else {
    // Genuinely different action (new version, new issues, new recipient...): nothing carries over.
    state.pendingAction = action;
    state.approvedActionId = null;
    state.delivery = freshDelivery();
  }
  state.outcome = deriveOutcome(state);
  return state;
}

function onApprove(state, actionId) {
  // Only the trusted controller event, and only for the exact current action.
  if (!state.pendingAction || actionId !== state.pendingAction.id) {
    state.outcome = 'approval_rejected: action id does not match current pending action';
    return state; // pending action and any valid existing approval unchanged
  }
  state.approvedActionId = state.pendingAction.id;
  state.outcome = deriveOutcome(state);
  return state;
}

async function onSend(state, tools) {
  const action = state.pendingAction;
  if (!action) { state.outcome = 'blocked: no pending action'; return state; }
  if (state.approvedActionId !== action.id) { state.outcome = 'blocked: not approved'; return state; }
  if (state.delivery.status === 'sent') { state.outcome = 'sent'; return state; }
  if (state.delivery.attempts >= MAX_ATTEMPTS) { state.outcome = 'needs_reconciliation'; return state; }

  state.delivery.attempts += 1;
  try {
    const result = await tools.notify({
      idempotencyKey: action.id, recipient: action.recipient, text: action.text,
    });
    if (typeof result?.receiptId === 'string' && result.receiptId.length > 0) {
      state.delivery.status = 'sent';
      state.delivery.receiptId = result.receiptId;
      delete state.delivery.lastError;
    } else {
      // A response without a receipt is not evidence of delivery.
      state.delivery.status = 'unknown';
      state.delivery.lastError = 'response without receiptId';
    }
  } catch (error) {
    // A timeout (or any error) does not prove nothing happened: the service may have delivered.
    state.delivery.status = 'unknown';
    state.delivery.receiptId = null;
    state.delivery.lastError = error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error);
  }
  state.outcome = deriveOutcome(state);
  return state;
}

export async function handle(previous, event, tools) {
  const prev = previous ?? initialState();
  const state = structuredClone(prev);
  if (!state.delivery) state.delivery = freshDelivery();

  switch (event?.type) {
    case 'LOAD_PROFILE': return onLoadProfile(prev, state, event.profile, tools);
    case 'APPROVE_ACTION': return onApprove(state, event.actionId);
    case 'SEND': return onSend(state, tools);
    default: throw new Error(`Unknown event: ${event?.type}`);
  }
}
