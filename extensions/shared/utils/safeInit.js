/**
 * Startup guards shared by the browser background scripts.
 *
 * Background scripts run a chain of init steps before opening the server
 * connection. A throw in any of them kills the whole script, so the
 * extension never connects and the popup hangs at "Connecting…" with no
 * add-on-prefixed error (see issue #49). These helpers keep optional init
 * failures from reaching the connection code, and make the fatal case
 * loud when something truly unrecoverable happens.
 */

/**
 * Run one non-essential init step, logging (never rethrowing) failures.
 * Accepts sync or async steps; returns a promise when the step is async.
 *
 * @param {string} productName - Log prefix, e.g. "Blueprint MCP for Chrome"
 * @param {string} stepName - Human-readable step name for the log line
 * @param {function} fn - The init step
 * @param {object} [logger] - Optional logger; falls back to console
 */
export function safeInit(productName, stepName, fn, logger = null) {
  const report = (error) => {
    const message = `[${productName}] Init step failed (continuing): ${stepName}:`;
    if (logger && logger.logAlways) {
      logger.logAlways(message, error);
    } else {
      console.error(message, error);
    }
  };

  try {
    const result = fn();
    if (result && typeof result.catch === 'function') {
      return result.catch((error) => {
        report(error);
      });
    }
    return result;
  } catch (error) {
    report(error);
    return undefined;
  }
}

/**
 * Attach a loud, product-prefixed handler to the background script's main
 * initialization promise. This is the line to look for when the extension
 * never connects.
 *
 * @param {Promise} initPromise - The main init IIFE's promise
 * @param {string} productName - Log prefix
 */
export function reportFatalInit(initPromise, productName) {
  return initPromise.catch((error) => {
    console.error(
      `[${productName}] FATAL: background initialization failed, extension will not connect:`,
      error
    );
  });
}
