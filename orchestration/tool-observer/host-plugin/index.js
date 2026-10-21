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

  // The host loader only observes the synchronous setup call. A cleanup that
  // never settles must not turn apply() or the returned disposer into an
  // unbounded wait. The timeout is a fixed M0 config value; the wrapper never
  // derives source identity or a cleanup deadline from the context.
  function boundedStop(controller, timeoutMs) {
    let timer;
    const stop = Promise.resolve()
      .then(() => {
        if (!controller || typeof controller.stop !== 'function') return { status: 'missing' };
        return controller.stop();
      })
      .then(
        (value) => ({ status: 'resolved', value }),
        (error) => ({ status: 'rejected', error })
      );
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    });
    return Promise.race([stop, timeout]).finally(() => clearTimeout(timer));
  }

  function cleanupState(result) {
    if (result.status === 'resolved' && result.value?.ok === true) {
      return { status: 'settled', ok: true, ownershipUncertain: false };
    }
    if (result.status === 'timeout') {
      return { status: 'timeout', ok: false, ownershipUncertain: true };
    }
    return { status: 'failed', ok: false, ownershipUncertain: true };
  }

  function setupError(code, result) {
    const error = new TraceError(code, 'observer setup failed');
    error.cleanup = cleanupState(result);
    return error;
  }

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
      const rollback = await boundedStop(controller, normalized.cleanupTimeoutMs);
      throw setupError(code, rollback);
    }

    let cleanup = null;
    return function dispose() {
      if (cleanup === null) {
        cleanup = (async () => {
          const stopped = await boundedStop(controller, normalized.cleanupTimeoutMs);
          if (stopped.status === 'timeout') {
            const error = new TraceError('CLEANUP_TIMEOUT', 'observer cleanup timed out');
            error.cleanup = cleanupState(stopped);
            throw error;
          }
          if (stopped.status === 'rejected') {
            const error = new TraceError('STOP_FAILED', 'observer stop failed');
            error.cleanup = cleanupState(stopped);
            throw error;
          }
          const result = stopped.value;
          if (!result || result.ok !== true) {
            const error = new TraceError(fixedCode(result?.code, 'STOP_FAILED'), 'observer stop failed');
            error.cleanup = cleanupState(stopped);
            throw error;
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
