import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonScript = path.join(repoRoot, 'scripts', 'run_e2e_server.py');

const candidates = [
  path.join(repoRoot, '.venv', 'bin', 'python'),
  path.join(repoRoot, '.venv', 'Scripts', 'python.exe'),
  'python',
  'python3',
];

function pickPython() {
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  return 'python3';
}

const child = spawn(pickPython(), [pythonScript], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
