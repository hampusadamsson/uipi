/**
 * Timer functions exist in both browsers and Node, but this package is
 * deliberately compiled without DOM or Node ambient types so it stays
 * environment-agnostic. Declare just the two we use.
 */
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;
