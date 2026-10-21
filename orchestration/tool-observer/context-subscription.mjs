// Thin Cordis-shaped registration boundary. The caller supplies the context
// explicitly. This module does not import, discover or execute DSH code; import
// alone has no side effects, and no registration happens until attach() invokes
// the subscriber returned here.
import { TraceError } from '../../tools/lib/tool-trace-contracts.mjs';

export function createContextSubscriber(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    throw new TraceError('SUBSCRIBE_FAILED', 'ctx.on is required');
  }
  // Keep the method receiver: ctx.on is invoked as a method, never detached.
  // No ctx.off, options object, global or prepend flag is passed.
  return function subscribe(eventName, callback) {
    const disposer = ctx.on(eventName, callback);
    if (typeof disposer !== 'function') {
      throw new TraceError('SUBSCRIBE_FAILED', 'ctx.on did not return a disposer');
    }
    return disposer;
  };
}
