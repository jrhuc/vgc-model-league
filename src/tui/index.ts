import { App } from './app.js';
import { SetupScreen } from './setup.js';

export async function runTui(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('the vgcbench TUI needs an interactive terminal; see `vgcbench help` for batch commands');
    return 2;
  }
  const app = new App();
  await app.run(new SetupScreen(app));
  return 0;
}
