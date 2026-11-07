import { handle } from './workflow.mjs';
import { initialState } from './contract.mjs';
import { createHarness } from './mock-tools.mjs';

try {
  if (typeof handle !== 'function') throw new Error('Missing handle export');
  const harness = createHarness();
  const state = await handle(initialState(), { type: 'SEND' }, harness.tools);
  if (!state || typeof state !== 'object' || !state.delivery) throw new Error('Invalid state shape');
  console.log('SETUP PASS: Node can import the files, call the workflow and read state.');
  console.log('This deliberately passes for the broken starter. Now run: node run.mjs');
} catch (error) {
  console.error(`SETUP FAIL: ${error.message}`);
  process.exitCode = 2;
}
