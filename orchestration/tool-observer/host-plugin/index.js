// Loader-shaped wrapper for the reviewed M0 composition factory.
//
// The host loader collects a function or Promise<function> as the plugin
// effect. This entry therefore never returns the M0 controller object. The
// wrapper is still an offline candidate: it does not import DSH, discover a
// context or prove that a real host mounted it.
import {
  createToolObserver,
  validateConfig
} from '../plugin/index.js';
import { TraceError } from '../../../tools/lib/tool-trace-contracts.mjs';

const SAFE_CODES = new Set([
  'CONFIG_INVALID', 'PATH_BLOCKED', 'WRITE_FAILED', 'CLEANUP_FAILED',
  'CLEANUP_TIMEOUT', 'CLOSE_FAILED', 'SETUP_FAILED', 'STOP_FAILED'
]);

function fixedCode(value, fallback) {
  return typeof value === 'string' && SAFE_CODES.has(value) ? value : fallback;
}

export function createLoaderPlugin({ factory = createToolObserver } = {}) {
  if (typeof factory !== 'function') throw new TraceError('CONFIG_INVALID', 'factory is invalid');

  async function apply(ctx, config) {
    let normalized;
    try {
      normalized = validateConfig(config);
    } catch {
      throw new TraceError('CONFIG_INVALID', 'observer config is invalid');
    }
    if (normalized.enabled === false) return undefined;

    let controller;
    try {
      controller = await factory({ ctx, config, origin: 'host-notification' });
    } catch {
      throw new TraceError('SETUP_FAILED', 'observer setup failed');
    }
    if (!controller || controller.enabled !== true || controller.ok !== true ||
        typeof controller.stop !== 'function') {
      const code = fixedCode(controller?.code, 'SETUP_FAILED');
      try { await controller?.stop?.(); } catch { /* rollback is secondary */ }
      throw new TraceError(code, 'observer setup failed');
    }

    let cleanup = null;
    return function dispose() {
      if (cleanup === null) {
        cleanup = (async () => {
          let result;
          try {
            result = await controller.stop();
          } catch {
            throw new TraceError('STOP_FAILED', 'observer stop failed');
          }
          if (!result || result.ok !== true) {
            throw new TraceError(fixedCode(result?.code, 'STOP_FAILED'), 'observer stop failed');
          }
        })();
      }
      return cleanup;
    };
  }

  return { name: 'tla-tool-observer', inject: [], apply };
}

const plugin = createLoaderPlugin();

export const name = plugin.name;
export const inject = plugin.inject;
export const apply = plugin.apply;
