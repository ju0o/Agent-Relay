// Deterministic fixture worker — exit non-zero.
await new Promise((r) => setTimeout(r, 50));
process.exit(7);
