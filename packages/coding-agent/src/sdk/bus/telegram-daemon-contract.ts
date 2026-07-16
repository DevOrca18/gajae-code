/**
 * Lightweight daemon protocol contract for consumers that need generation
 * metadata without loading the Telegram daemon runtime.
 */

/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 3;

/**
 * Operational generation of the daemon lifecycle and ownership contract.
 * This intentionally changes only when daemon behavior or lifecycle semantics
 * require replacement; it is independent from the notification wire protocol.
 */
export const DAEMON_GENERATION = 4;
