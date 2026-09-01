// Deterministic fixture worker — stay alive until timeout or signal.
const ms = Number(process.env.WORKER_STAY_MS || 3000);
await new Promise((r) => setTimeout(r, ms));
process.exit(0);
