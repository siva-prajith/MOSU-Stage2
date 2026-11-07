// Exercise-owned mock services. No network, accounts, credentials or real messages.
// The workflow receives only `tools`; tests keep `inspect` and setters private.
export function createHarness({ mode = 'success', variant = false, note = 'Reference information only.' } = {}) {
  const profile = variant ? {
    id: 'profile-862', version: 9, protocolId: 'standard-fit',
    recipient: 'customer-862@example.test',
    measurements: {
      chest: null,
      waist: { value: 34, unit: 'in' },
      hip: { value: 97, unit: 'cm' },
    },
  } : {
    id: 'profile-017', version: 4, protocolId: 'standard-fit',
    recipient: 'customer-017@example.test',
    measurements: {
      chest: { value: 92, unit: 'cm' },
      waist: null,
      hip: { value: 38, unit: 'in' },
    },
  };
  let protocol = {
    id: 'standard-fit', revision: 'r1',
    requiredFields: ['chest', 'waist', 'hip'], requiredUnit: 'cm', note,
  };
  const calls = [];
  const deliveries = new Map();
  const toolCalls = [];

  const tools = Object.freeze({
    async readProtocol(protocolId) {
      toolCalls.push({ tool: 'readProtocol', protocolId });
      if (protocolId !== protocol.id) throw new Error('Unknown protocol');
      return structuredClone(protocol);
    },
    async draftClarification({ profileId, profileVersion, issues }) {
      toolCalls.push({ tool: 'draftClarification', profileId, profileVersion, issues: structuredClone(issues) });
      if (typeof profileId !== 'string' || !Number.isInteger(profileVersion) ||
          !Array.isArray(issues) || !issues.every(x => typeof x === 'string')) {
        throw new Error('Invalid drafting input');
      }
      return `Please clarify ${profileId} version ${profileVersion}: ${issues.join(', ')}.`;
    },
    async notify(input) {
      const { idempotencyKey, recipient, text } = input ?? {};
      const payload = { idempotencyKey, recipient, text };
      // An attempted tool call counts even when its input is invalid.
      calls.push(structuredClone(payload));
      toolCalls.push({ tool: 'notify', ...structuredClone(payload) });
      if (![idempotencyKey, recipient, text].every(x => typeof x === 'string' && x.length > 0)) {
        throw new Error('Invalid notification input');
      }
      let delivery = deliveries.get(idempotencyKey);
      if (delivery && (delivery.recipient !== recipient || delivery.text !== text)) {
        throw new Error('Idempotency key reused with a different payload');
      }
      if (!delivery) {
        delivery = { ...payload, receiptId: `receipt-${deliveries.size + 1}` };
        deliveries.set(idempotencyKey, delivery);
      }
      if (mode === 'commit_timeout_always' ||
          (mode === 'commit_timeout_once' && calls.length === 1)) {
        const error = new Error('Response timed out; delivery outcome is uncertain');
        error.code = 'TIMEOUT';
        throw error;
      }
      return { receiptId: delivery.receiptId };
    },
  });

  return {
    profile: structuredClone(profile),
    expectedIssues: variant ? ['missing:chest', 'unit:waist:in'] : ['missing:waist', 'unit:hip:in'],
    tools,
    setProtocolRevision(revision) { protocol = { ...protocol, revision }; },
    inspect() {
      return structuredClone({ calls, deliveries: [...deliveries.values()], toolCalls });
    },
  };
}
