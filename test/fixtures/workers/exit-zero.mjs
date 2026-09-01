// Deterministic fixture worker — exit 0 after a short delay.
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
