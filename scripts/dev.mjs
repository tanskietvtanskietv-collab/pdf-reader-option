/**
 * Runs the API and the Vite dev server side by side with prefixed output.
 * Deliberately dependency free, so `npm run dev` works without a root install.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Single command string + shell: npm resolves to npm.cmd on Windows, and Node
// does not warn about unescaped argument arrays.
const targets = [
  { name: 'server', color: '\x1b[36m', command: 'npm --prefix server run dev' },
  { name: 'client', color: '\x1b[35m', command: 'npm --prefix client run dev' },
];

const children = [];
let shuttingDown = false;

function prefixed(name, color, chunk) {
  const reset = '\x1b[0m';
  return String(chunk)
    .split('\n')
    .filter((line, index, lines) => line !== '' || index < lines.length - 1)
    .map((line) => `${color}[${name}]${reset} ${line}`)
    .join('\n');
}

for (const { name, color, command } of targets) {
  const child = spawn(command, { cwd: root, shell: true });
  children.push(child);

  child.stdout.on('data', (chunk) => console.log(prefixed(name, color, chunk)));
  child.stderr.on('data', (chunk) => console.error(prefixed(name, color, chunk)));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(prefixed(name, color, `exited with code ${code}`));
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));
