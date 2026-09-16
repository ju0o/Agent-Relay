import fs from 'node:fs';
const counter = process.argv[2];
const n = Number(fs.readFileSync(counter, 'utf8') || '0') + 1;
fs.writeFileSync(counter, String(n));
const id = 'AC-SEMANTIC';
if (n === 1) {
  console.log('status: FAIL'); console.log('failedCriteria:'); console.log(`- ${id}`);
  console.log('reason: semantic criterion failed on attempt one');
  console.log('remediationInstruction: write the correct output');
} else { console.log('status: PASS'); console.log('criteria:'); console.log(`- ${id}: PASS`); }
