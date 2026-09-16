import fs from 'node:fs';
const output = process.env.FAKE_BUILDER_OUTPUT || `${process.cwd()}/out.txt`;
const countFile = process.env.FAKE_BUILDER_COUNTER || `${process.cwd()}/.builder-attempt`;
const n = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : '0') + 1;
fs.writeFileSync(countFile, String(n));
fs.writeFileSync(output, n === 1 ? 'wrong' : 'correct');
console.log(`builder attempt ${n}`);
