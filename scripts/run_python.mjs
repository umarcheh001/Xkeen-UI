import { spawnSync } from 'node:child_process';

function usage() {
  console.error('Usage: node scripts/run_python.mjs <script.py> [args...]');
  process.exit(1);
}

function buildCandidates() {
  const candidates = [];
  const fromEnv = String(process.env.PYTHON || '').trim();
  if (fromEnv) candidates.push([fromEnv]);
  candidates.push(['python'], ['python3']);
  if (process.platform === 'win32') {
    candidates.push(['py', '-3'], ['py']);
  }
  return candidates;
}

function supportsPython3(command, baseArgs) {
  const probe = spawnSync(command, [...baseArgs, '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 0) else 1)'], {
    stdio: 'ignore',
  });
  return !probe.error && probe.status === 0;
}

function resolvePython() {
  for (const candidate of buildCandidates()) {
    const [command, ...baseArgs] = candidate;
    if (supportsPython3(command, baseArgs)) {
      return { command, baseArgs };
    }
  }
  return null;
}

const scriptArgs = process.argv.slice(2);
if (!scriptArgs.length) usage();

const resolved = resolvePython();
if (!resolved) {
  console.error('Python 3 interpreter not found. Set PYTHON or install python/python3.');
  process.exit(1);
}

const result = spawnSync(resolved.command, [...resolved.baseArgs, ...scriptArgs], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message || String(result.error));
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
