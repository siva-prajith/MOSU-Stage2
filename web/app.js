// MOSU stage-2 visual demonstrator.
// Every workflow button dispatches ONE real event to the unchanged stage-1 handle().
// Diagram, state panel and trace are all rendered from the same persisted state + recorded tool calls.
import { handle } from '../workflow.mjs';
import { initialState, MAX_ATTEMPTS } from '../contract.mjs';
import { createHarness } from '../mock-tools.mjs';

// ---------- Scenarios (scripted step-through; decision steps need an explicit control) ----------
const SCENARIOS = {
  A: {
    title: 'A. Normal execution', mode: 'success',
    steps: [
      { ev: 'LOAD', label: 'Load fictional profile v4 (waist missing, hip in inches)',
        narr: 'LOAD_PROFILE reads the protocol, validates the snapshot and, because there are issues, asks the simulated AI drafting tool for clarification text. Nothing is invented or converted.' },
      { ev: 'SEND', label: 'Try to send while approval is withheld',
        narr: 'Approval is withheld. The harness checks approvedActionId === pendingAction.id before notify() is reachable, so this SEND makes zero provider calls and consumes no attempt.' },
      { ev: 'APPROVE', decision: true, label: 'DECISION: approve this exact action (Approve control)',
        narr: 'A human approves the specific action ID, which binds profile, version, recipient and exact text. The note in the protocol has no authority.' },
      { ev: 'SEND', label: 'Send through the mock notification service',
        narr: 'One notify() call with idempotencyKey = action ID. A receipt comes back, so delivery is recorded as sent.' },
    ],
  },
  B: {
    title: 'B. Delivered, but the response times out', mode: 'commit_timeout_once',
    steps: [
      { ev: 'LOAD', label: 'Load fictional profile v4',
        narr: 'Same validation and drafting as scenario A.' },
      { ev: 'APPROVE', decision: true, label: 'DECISION: approve this exact action',
        narr: 'Approval is bound to this action ID.' },
      { ev: 'SEND', label: 'Send (provider delivers, then the response times out)',
        narr: 'The provider stores the message, but the app only receives a TIMEOUT error. The app must not claim sent or failed: the honest state is unknown, 1 of 2 attempts used, no receipt.' },
      { ev: 'SEND', decision: true, label: 'DECISION: choose the permitted retry (attempt 2 of 2)',
        narr: 'Paused at unknown. Retrying is safe only because it reuses the same idempotency key and the same recipient/text, so the provider returns the original receipt instead of delivering again.' },
    ],
  },
  B2: {
    title: 'B2. Both attempts time out (limit check)', mode: 'commit_timeout_always',
    steps: [
      { ev: 'LOAD', label: 'Load fictional profile v4', narr: 'Same as A.' },
      { ev: 'APPROVE', decision: true, label: 'DECISION: approve this exact action', narr: 'Approval bound to this action ID.' },
      { ev: 'SEND', label: 'Send (times out)', narr: 'Attempt 1 of 2: unknown.' },
      { ev: 'SEND', decision: true, label: 'DECISION: retry (attempt 2 of 2, times out again)', narr: 'Attempt 2 of 2: still unknown. The loop has reached its limit.' },
      { ev: 'SEND', label: 'Try a third send', narr: 'Blocked by the attempt limit: no provider call. Outcome needs_reconciliation hands the case to a human to check provider records.' },
    ],
  },
};

// ---------- Diagram definition ----------
const W = 124, H = 52;
const NODES = [
  { id: 'protocol', t: ['Designer defines', 'versioned protocol'], x: 8, y: 20, kind: 'concept' },
  { id: 'load', t: ['Profile version', 'loaded'], x: 150, y: 20 },
  { id: 'validate', t: ['Validate against', 'protocol fields/unit'], x: 292, y: 20 },
  { id: 'draft', t: ['Draft clarification', '(simulated AI)'], x: 434, y: 20, kind: 'ai' },
  { id: 'approval', t: ['Awaiting human', 'approval'], x: 576, y: 20 },
  { id: 'approved', t: ['Exact action', 'approved'], x: 718, y: 20 },
  { id: 'send', t: ['notify() call', 'mock provider'], x: 860, y: 20 },
  { id: 'ready', t: ['Ready for', 'designer review'], x: 292, y: 150 },
  { id: 'wait', t: ['Waiting for', 'corrected version'], x: 576, y: 150, kind: 'concept' },
  { id: 'sent', t: ['Clarification sent', '(receipt recorded)'], x: 718, y: 150 },
  { id: 'unknown', t: ['Delivery UNKNOWN', '(timeout, no receipt)'], x: 860, y: 150 },
  { id: 'review', t: ['Designer review:', 'accept / clarify / reject'], x: 292, y: 270, kind: 'concept' },
  { id: 'handoff', t: ['Production handoff', '(accepted version)'], x: 434, y: 270, kind: 'concept' },
  { id: 'recon', t: ['Needs', 'reconciliation'], x: 860, y: 270 },
];
const N = Object.fromEntries(NODES.map(n => [n.id, n]));
const R = (n, dy = H / 2) => [n.x + W, n.y + dy];
const L = (n, dy = H / 2) => [n.x, n.y + dy];
const B = (n, dx = W / 2) => [n.x + dx, n.y + H];
const T = (n, dx = W / 2) => [n.x + dx, n.y];
const EDGES = [
  { a: R(N.protocol), b: L(N.load), kind: 'concept' },
  { a: R(N.load), b: L(N.validate) },
  { a: R(N.validate), b: L(N.draft), label: 'has issues', under: true },
  { a: B(N.validate), b: T(N.ready), label: 'no issues' },
  { a: R(N.draft), b: L(N.approval) },
  { a: R(N.approval), b: L(N.approved), label: 'APPROVE (exact id)', under: true },
  { a: R(N.approved), b: L(N.send), label: 'SEND', under: true },
  { a: B(N.send, 30), b: T(N.sent, 90), label: 'receipt' },
  { a: B(N.send, 80), b: T(N.unknown, 80), label: 'timeout' },
  { path: `M ${N.unknown.x + W} ${N.unknown.y + 20} C ${N.unknown.x + W + 34} ${N.unknown.y}, ${N.send.x + W + 34} ${N.send.y + H}, ${N.send.x + W} ${N.send.y + 32}`,
    label: 'retry ≤ 2', lx: N.send.x + W + 6, ly: 112, kind: 'loop' },
  { a: B(N.unknown), b: T(N.recon), label: '2 attempts used' },
  { a: L(N.sent), b: R(N.wait), kind: 'concept' },
  { path: `M ${N.wait.x + W / 2} ${N.wait.y + H} L ${N.wait.x + W / 2} 236 L ${N.load.x + W / 2} 236 L ${N.load.x + W / 2} ${N.load.y + H}`,
    label: 'correction = new version', lx: 440, ly: 230, kind: 'concept' },
  { a: B(N.ready), b: T(N.review), kind: 'concept' },
  { a: R(N.review), b: L(N.handoff), kind: 'concept' },
];

// ---------- Session ----------
let session;
function newSession(key) {
  const sc = SCENARIOS[key];
  const harness = createHarness({ mode: sc.mode });
  session = { key, sc, harness, state: initialState(), trace: [], ptr: 0, busy: false, protocolRev: 1 };
  render();
}

// Tool wrapper = the harness boundary: records exactly what the workflow asked and what it got back.
function tracedTools(log) {
  const labels = { readProtocol: 'protocol service (mock)', draftClarification: 'SIMULATED AI drafting (deterministic mock)', notify: 'notification provider (mock)' };
  const wrap = name => async input => {
    const call = { tool: name, label: labels[name], input: structuredClone(input) };
    log.push(call);
    try {
      const out = await session.harness.tools[name](input);
      call.ok = true; call.output = structuredClone(out);
      return out;
    } catch (e) {
      call.ok = false; call.error = `${e.code ? e.code + ': ' : ''}${e.message}`;
      throw e;
    }
  };
  return { readProtocol: wrap('readProtocol'), draftClarification: wrap('draftClarification'), notify: wrap('notify') };
}

function view(s) {
  return {
    profile: s.currentProfile ? `${s.currentProfile.id} v${s.currentProfile.version}` : null,
    protocolRevision: s.currentProtocol?.revision ?? null,
    issues: (s.issues ?? []).join(', ') || '(none)',
    reviewStatus: s.reviewStatus,
    pendingAction: s.pendingAction?.id ?? null,
    approved: Boolean(s.pendingAction && s.approvedActionId === s.pendingAction.id),
    'delivery.status': s.delivery.status,
    'delivery.attempts': s.delivery.attempts,
    'delivery.receiptId': s.delivery.receiptId,
    outcome: s.outcome,
  };
}

async function dispatch(event, meta = {}) {
  if (session.busy) return;
  session.busy = true; render();
  const before = session.state;
  const log = [];
  let error = null;
  try {
    const result = await handle(structuredClone(before), structuredClone(event), tracedTools(log));
    // Same persistence boundary as the stage-1 runner: only JSON state survives between events.
    session.state = JSON.parse(JSON.stringify(result));
  } catch (e) { error = e.message; }
  const vb = view(before), va = view(session.state);
  const changes = Object.keys(va).filter(k => JSON.stringify(vb[k]) !== JSON.stringify(va[k]))
    .map(k => ({ k, from: vb[k], to: va[k] }));
  const step = session.sc.steps[session.ptr];
  const evName = event.type === 'LOAD_PROFILE' ? 'LOAD' : event.type === 'APPROVE_ACTION' ? 'APPROVE' : 'SEND';
  const onScript = !meta.offScript && step && step.ev === evName;
  session.trace.push({ n: session.trace.length + 1, event: summarize(event), calls: log, changes, error,
    stage: activeStage(session.state), note: meta.note, scripted: onScript ? step.label : null });
  if (onScript) session.ptr++;
  session.busy = false;
  render();
}

function summarize(e) {
  if (e.type === 'LOAD_PROFILE') return `LOAD_PROFILE ${e.profile.id} v${e.profile.version}`;
  if (e.type === 'APPROVE_ACTION') return `APPROVE_ACTION ${e.actionId ?? '(none)'}`;
  return e.type;
}

const loadEvent = profile => ({ type: 'LOAD_PROFILE', profile: profile ?? session.harness.profile });
const actions = {
  LOAD: () => dispatch(loadEvent()),
  APPROVE: () => dispatch({ type: 'APPROVE_ACTION', actionId: session.state.pendingAction?.id }),
  SEND: () => dispatch({ type: 'SEND' }),
  NEXT: () => { const st = session.sc.steps[session.ptr]; if (st && !st.decision) actions[st.ev](); },
  CORRECTED: () => {
    const p = structuredClone(session.state.currentProfile ?? session.harness.profile);
    p.version += 1;
    p.measurements = { chest: { value: 92, unit: 'cm' }, waist: { value: 78, unit: 'cm' }, hip: { value: 97, unit: 'cm' } };
    dispatch(loadEvent(p), { offScript: true, note: 'Changed condition: corrected profile submitted as a NEW version (old version is not overwritten).' });
  },
  PROTOCOL: () => {
    session.protocolRev += 1;
    session.harness.setProtocolRevision(`r${session.protocolRev}`);
    dispatch(loadEvent(session.state.currentProfile ?? undefined),
      { offScript: true, note: `Changed condition: designer revised the protocol to r${session.protocolRev} (same fields/unit), then the same profile was reloaded.` });
  },
};

// ---------- Derived stage (from state only) ----------
function activeStage(s) {
  if (!s.currentProfile) return null;
  if (String(s.outcome).startsWith('load_failed')) return 'load';
  if (s.reviewStatus === 'ready_for_review') return 'ready';
  if (!s.pendingAction) return 'validate';
  const d = s.delivery;
  if (d.status === 'sent') return 'sent';
  if (d.status === 'unknown') return d.attempts >= MAX_ATTEMPTS ? 'recon' : 'unknown';
  return s.approvedActionId === s.pendingAction.id ? 'approved' : 'approval';
}
function executedStages() {
  const seen = new Set();
  for (const t of session.trace) {
    for (const c of t.calls) {
      if (c.tool === 'readProtocol') { seen.add('load'); seen.add('validate'); }
      if (c.tool === 'draftClarification') seen.add('draft');
      if (c.tool === 'notify') seen.add('send');
    }
    if (t.stage) seen.add(t.stage);
  }
  return seen;
}

// ---------- Rendering ----------
const $ = id => document.getElementById(id);
const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = v => v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function renderDiagram() {
  const active = activeStage(session.state);
  const seen = executedStages();
  let svg = `<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="arrowhead"/></marker></defs>`;
  for (const e of EDGES) {
    const d = e.path ?? `M ${e.a[0]} ${e.a[1]} L ${e.b[0]} ${e.b[1]}`;
    svg += `<path d="${d}" class="edge ${e.kind ?? ''}" marker-end="url(#ar)"/>`;
    if (e.label) {
      if (e.under) {
        const mx = (e.a[0] + e.b[0]) / 2;
        svg += `<path d="M ${mx} ${e.a[1] + 4} L ${mx} ${e.a[1] + 30}" class="edge tick"/>`;
        svg += `<text x="${mx}" y="${e.a[1] + 42}" class="elabel" text-anchor="middle">${esc(e.label)}</text>`;
      } else {
        const lx = e.lx ?? (e.a[0] + e.b[0]) / 2 + 4, ly = e.ly ?? (e.a[1] + e.b[1]) / 2 - 5;
        svg += `<text x="${lx}" y="${ly}" class="elabel">${esc(e.label)}</text>`;
      }
    }
  }
  for (const n of NODES) {
    const cls = ['node', n.kind ?? 'exec', n.id === active ? 'active' : '', seen.has(n.id) ? 'seen' : ''].join(' ');
    svg += `<g class="${cls}" data-stage="${n.id}"><rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="8"/>`;
    svg += `<text x="${n.x + W / 2}" y="${n.y + 21}">${esc(n.t[0])}</text><text x="${n.x + W / 2}" y="${n.y + 37}" class="sub">${esc(n.t[1])}</text>`;
    if (n.kind === 'concept') svg += `<text x="${n.x + W - 6}" y="${n.y - 4}" class="tag" text-anchor="end">conceptual</text>`;
    if (n.kind === 'ai') svg += `<text x="${n.x + W - 6}" y="${n.y - 4}" class="tag ai" text-anchor="end">simulated AI</text>`;
    svg += `</g>`;
  }
  $('diagram').innerHTML = svg;
  $('activeLabel').textContent = active ? N[active].t.join(' ') : 'nothing loaded yet';
}

function renderState() {
  const s = session.state, a = s.pendingAction;
  const approved = Boolean(a && s.approvedActionId === a.id);
  const rows = [
    ['Profile / version', s.currentProfile ? `${s.currentProfile.id} · v${s.currentProfile.version}` : '—'],
    ['Recipient (from profile)', s.currentProfile?.recipient ?? '—'],
    ['Protocol / revision', s.currentProtocol ? `${s.currentProtocol.id} · ${s.currentProtocol.revision} · unit ${s.currentProtocol.requiredUnit}` : '—'],
    ['Validation issues', s.issues.length ? s.issues.map(i => `<code>${esc(i)}</code>`).join(' ') : (s.currentProfile ? 'none' : '—'), true],
    ['Review status', s.reviewStatus],
    ['Pending action', a ? `<code>${esc(a.id)}</code><br><small>${esc(a.kind)} → ${esc(a.recipient)}</small><br><small>“${esc(a.text)}”</small>` : '—', true],
    ['Approval', a ? (approved ? `<span class="ok">approved for this exact action</span>` : `<span class="warn">withheld (approvedActionId: ${esc(fmt(s.approvedActionId))})</span>`) : '—', true],
    ['Delivery status', `<span class="st st-${esc(s.delivery.status)}">${esc(s.delivery.status)}</span>`, true],
    ['Attempts', `${s.delivery.attempts} of ${MAX_ATTEMPTS}`],
    ['Receipt (from tool response)', fmt(s.delivery.receiptId)],
    ['Last tool error', fmt(s.delivery.lastError)],
    ['Outcome', `<b>${esc(s.outcome)}</b>`, true],
  ];
  $('state').innerHTML = rows.map(([k, v, html]) => `<tr><th>${esc(k)}</th><td>${html ? v : esc(v)}</td></tr>`).join('');
  $('rawState').textContent = JSON.stringify(s, null, 2);
}

function renderCounts() {
  const calls = session.trace.flatMap(t => t.calls).filter(c => c.tool === 'notify');
  const receipts = calls.filter(c => c.ok).length;
  $('appCounts').innerHTML = `
    <div class="kpi"><b>${calls.length}</b><span>notification requests made by the app</span></div>
    <div class="kpi"><b>${receipts}</b><span>responses with a receipt</span></div>
    <div class="kpi"><b>${calls.length - receipts}</b><span>timeouts / errors (outcome uncertain)</span></div>`;
  const p = session.harness.inspect();
  $('providerCounts').innerHTML = `<div class="kpi"><b>${p.deliveries.length}</b><span>actual deliveries inside the provider</span></div>
    <div class="plist">${p.deliveries.map(d => `<div><code>${esc(d.receiptId)}</code> for key <code>${esc(d.idempotencyKey)}</code></div>`).join('') || '<div>none</div>'}</div>`;
}

function renderTrace() {
  if (!session.trace.length) { $('trace').innerHTML = '<p class="muted">No events executed yet. Use “Next step” or a workflow control.</p>'; return; }
  $('trace').innerHTML = session.trace.slice().reverse().map(t => `
    <div class="tev">
      <div class="thead"><span class="num">#${t.n}</span> <b>input:</b> <code>${esc(t.event)}</code>
        ${t.scripted ? `<span class="pill">scenario step</span>` : `<span class="pill off">manual / off-script</span>`}</div>
      ${t.note ? `<div class="tnote">${esc(t.note)}</div>` : ''}
      <div class="tcalls">${t.calls.length ? t.calls.map(c => `
        <div class="call ${c.ok ? '' : 'err'} ${c.tool === 'draftClarification' ? 'aicall' : ''}">
          <b>tool call</b> <code>${esc(c.tool)}</code> <small>${esc(c.label)}</small><br>
          <small>args:</small> <code>${esc(JSON.stringify(c.input))}</code><br>
          ${c.ok ? `<small>result:</small> <code>${esc(JSON.stringify(c.output))}</code>` : `<small>error:</small> <code>${esc(c.error)}</code>`}
        </div>`).join('') : `<div class="call none">no tool calls${t.event === 'SEND' ? ' (blocked before notify() was reachable)' : ''}</div>`}</div>
      <div class="tchanges"><b>state changes:</b> ${t.changes.length ? t.changes.map(c => `<span class="chg"><code>${esc(c.k)}</code>: ${esc(fmt(c.from))} → <b>${esc(fmt(c.to))}</b></span>`).join(' ') : '<span class="muted">none</span>'}</div>
      ${t.error ? `<div class="call err">handler error: ${esc(t.error)}</div>` : ''}
    </div>`).join('');
}

function renderControls() {
  const s = session.state, sc = session.sc, st = sc.steps[session.ptr];
  $('scenarioTitle').textContent = sc.title;
  $('steps').innerHTML = sc.steps.map((x, i) =>
    `<li class="${i < session.ptr ? 'done' : i === session.ptr ? 'now' : ''}">${x.decision ? '<span class="dec">decision</span> ' : ''}${esc(x.label)}</li>`).join('');
  $('narration').textContent = st ? st.narr : 'Scenario complete. You can still use the controls or the changed-condition buttons, or Reset.';
  const next = $('btnNext');
  next.disabled = session.busy || !st || st.decision;
  next.textContent = !st ? 'Scenario complete' : st.decision ? 'Decision point: use the highlighted control ↓' : `Next step ▶ ${st.label}`;
  const a = s.pendingAction, approved = Boolean(a && s.approvedActionId === a.id);
  $('btnLoad').disabled = session.busy;
  $('btnApprove').disabled = session.busy || !a || approved;
  $('btnSend').disabled = session.busy || !s.currentProfile;
  const uncertain = s.delivery.status === 'unknown';
  $('btnSend').textContent = uncertain
    ? (s.delivery.attempts < MAX_ATTEMPTS ? `Retry send (attempt ${s.delivery.attempts + 1} of ${MAX_ATTEMPTS}, same key)` : 'Send (attempt limit reached)')
    : 'Send';
  for (const b of ['btnApprove', 'btnSend']) $(b).classList.remove('pulse');
  if (st?.decision) $(st.ev === 'APPROVE' ? 'btnApprove' : 'btnSend').classList.add('pulse');
  $('btnCorrected').disabled = $('btnProtocol').disabled = session.busy || !s.currentProfile;
  const paused = uncertain && s.delivery.attempts < MAX_ATTEMPTS;
  $('pauseBox').hidden = !paused;
  $('reconBox').hidden = !(uncertain && s.delivery.attempts >= MAX_ATTEMPTS);
}

function render() { renderControls(); renderDiagram(); renderState(); renderCounts(); renderTrace(); }

// ---------- Wiring ----------
$('scenario').addEventListener('change', e => newSession(e.target.value));
$('btnReset').addEventListener('click', () => newSession($('scenario').value));
$('btnNext').addEventListener('click', actions.NEXT);
$('btnLoad').addEventListener('click', actions.LOAD);
$('btnApprove').addEventListener('click', actions.APPROVE);
$('btnSend').addEventListener('click', actions.SEND);
$('btnCorrected').addEventListener('click', actions.CORRECTED);
$('btnProtocol').addEventListener('click', actions.PROTOCOL);
window.__mosu = { get session() { return session; } }; // for automated verification only
newSession('A');
