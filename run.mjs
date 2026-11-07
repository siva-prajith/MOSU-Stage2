import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSuite, printReport } from './cases.mjs';

const args = process.argv.slice(2);
const modulePath = args.find(arg => !arg.startsWith('--')) ?? './workflow.mjs';
try {
  const { handle } = await import(pathToFileURL(resolve(modulePath)).href);
  if (typeof handle !== 'function') throw new Error('The module must export an async-compatible handle function.');
  const results = await runSuite(handle);
  const report = { passed: results.filter(x => x.passed).length, total: results.length, results };
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(results);
  process.exitCode = results.every(x => x.passed) ? 0 : 1;
} catch (error) {
  console.error(`Could not run the workflow: ${error.message}`);
  process.exitCode = 2;
}
