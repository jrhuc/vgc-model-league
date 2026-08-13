import type { ClientCapabilities } from './capability-contract.js';

export const STATIC_SITE = true;
export const CLIENT_CAPABILITIES: Readonly<ClientCapabilities> = {
  monitorRuns: false,
  startRuns: false,
};
