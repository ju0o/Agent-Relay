# Phase H regression evidence
1. `regression_list.v1.json` is the versioned Step 4 command census.
2. It covers every top-level `test/*.test.mjs` file in this repository.
3. Run one command at a time to avoid the documented concurrency flake.
4. Use `node scripts/run-regression-list.mjs --list docs/quality/regression_list.v1.json`.
5. Supply `--release-id <commit>` and `--out <evidence-dir>`.
6. The runner records each command's exit code and duration.
7. It writes `quality.evidence.v1.json` with Step 4 metadata.
8. `PASS` requires every declared command to match its expected exit code.
9. Any failure returns a non-zero process status and a `FAIL` evidence record.
10. The runner uses only the repository and output directory, never live dataRoot.
