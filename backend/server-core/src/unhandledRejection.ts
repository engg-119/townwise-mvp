/**
 * P-L1. Node crashes on an unhandled rejection by default. coffee-chat logs and
 * continues. Express 5 already turns request-path rejections into error responses,
 * so this function only sees background work. Returning 'shutdown' is cheap because
 * shutdown drains in-flight requests. Returning 'log' would keep a process running
 * in a state no one has checked. The spec states no recommended answer. This module
 * shuts the process down.
 */
export function onUnhandledRejection(reason: unknown): 'shutdown' | 'log' {
  // The rejection value does not change the decision. Shutdown drains in-flight work.
  return typeof reason === 'undefined' ? 'shutdown' : 'shutdown';
}
