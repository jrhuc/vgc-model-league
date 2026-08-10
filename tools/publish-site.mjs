import { execFileSync } from 'node:child_process';

/** Ship the exported site data through a pull request, since the main ruleset rejects direct pushes. */
const run = (command, args) =>
  execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();

run('git', ['add', 'artifacts/public/site']);
if (run('git', ['diff', '--cached', '--name-only']) === '') {
  console.log('site data unchanged; nothing to publish');
  process.exit(0);
}

const startBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const branch = `publish-site-${new Date().toISOString().replaceAll(/[-:.]/g, '').slice(0, 15)}`;
run('git', ['checkout', '-b', branch]);
try {
  run('git', ['commit', '-m', 'publish site data']);
  run('git', ['push', '-u', 'origin', branch]);
  run('gh', [
    'pr',
    'create',
    '--title',
    'Publish site data',
    '--body',
    'Automated site-data refresh from `pnpm run publish:site`.',
  ]);
  run('gh', ['pr', 'merge', branch, '--merge', '--delete-branch']);
} finally {
  run('git', ['checkout', startBranch]);
}
if (startBranch === 'main') run('git', ['pull', '--ff-only']);
console.log('site data published; the Pages workflow deploys it from main');
