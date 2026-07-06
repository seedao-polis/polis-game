// Domain read/write layer for the agent database, decomposed by concern under ./store/.
// This file is a thin re-export barrel so existing `import { ... } from './store.js'` and
// `import * as store from './store.js'` call sites keep working unchanged.
export * from './store/messages.js';
export * from './store/gamification.js';
export * from './store/events.js';
export * from './store/members.js';
export * from './store/analytics.js';
export * from './store/ops.js';
export * from './store/memory.js';
export * from './store/reactions.js';
