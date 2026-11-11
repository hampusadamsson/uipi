import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSessionRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { SessionService } from "./sessions.js";
import { createServer } from "./transport.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

const USAGE = `uipi — a web UI over the pi coding agent

Usage: uipi [options]

Options:
  --port <n>          HTTP + WebSocket listen port (1-65535)
  --host <h>          bind address
  --static <path>     built web assets to serve
  --cwd <path>        working directory new sessions default to
  --agent-dir <path>  pi agent dir (auth, settings, sessions, skills)
  -h, --help          print this help and exit

Environment:
  UIPI_PORT       HTTP + WebSocket listen port (default 8787)
  UIPI_HOST       bind address (default 127.0.0.1)
  UIPI_STATIC     built web assets to serve (default packages/web/dist)
  UIPI_CWD        default working directory (a --cwd flag wins)
  UIPI_AGENT_DIR  default pi agent dir (an --agent-dir flag wins)

Precedence: CLI flag > environment variable > built-in default.
`;

/** Everything `main()` needs to boot, already precedence-resolved. */
export interface ResolvedDefaults {
  port: number;
  host: string;
  /**
   * Absolute path to the built web assets, or `""` when neither `--static` nor
   * `UIPI_STATIC` was given. `""` is the "no override, use the built-in
   * default" sentinel: that default is relative to this module's own location
   * (`path.resolve(here, "../../web/dist")`), so only `main()` — which knows
   * `here` — can resolve it. `main()` therefore substitutes it, and the value
   * handed to the server is always an absolute path.
   */
  staticDir: string;
  cwd: string;
  agentDir: string;
  help: boolean;
}

/**
 * The `--` flags this resolver accepts; anything else throws. All five settings
 * are really wired up now: `main()` takes port, host and static dir from the
 * returned object, never from `process.env` directly.
 */
const VALUE_FLAGS = new Set(["port", "host", "static", "cwd", "agent-dir"]);

/** Expand a leading `~` (home dir) and make the path absolute. */
function expandPath(value: string, env: Record<string, string | undefined>): string {
  const home = env.HOME ?? homedir();
  const expanded = value === "~" || value.startsWith("~/") ? home + value.slice(1) : value;
  return path.resolve(expanded);
}

/**
 * Parse a port from a flag or env value, rejecting anything that is not a plain
 * integer in 1-65535 instead of letting `Number()` turn junk into `NaN`.
 * `source` names the origin (`--port`, `UIPI_PORT`) so the error says where the
 * bad value came from.
 */
function parsePort(raw: string, source: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`invalid ${source} "${raw}": expected an integer between 1 and 65535`);
  }
  const port = Number(raw.trim());
  if (port < 1 || port > 65535) {
    throw new Error(
      `invalid ${source} "${raw}": out of range, expected an integer between 1 and 65535`,
    );
  }
  return port;
}

/** Parse a host from a flag or env value; an empty bind address is an error. */
function parseHost(raw: string, source: string): string {
  const host = raw.trim();
  if (host === "") {
    throw new Error(`invalid ${source}: expected a non-empty bind address`);
  }
  return host;
}

/**
 * Resolve the server's startup settings from argv and the environment.
 *
 * Pure and side-effect free (all input arrives as arguments; the only ambient
 * reads are the `process.cwd()` / `getAgentDir()` built-in defaults), so it can
 * be unit tested. Precedence is CLI flag > env var > built-in default for every
 * setting. Paths get a leading `~` expanded and are resolved to absolute.
 *
 * `staticDir` comes back as `""` when unset — see {@link ResolvedDefaults}.
 *
 * An unknown `--` flag throws instead of being ignored, so a typo can never
 * silently boot the server with the wrong setting, and an unparseable port
 * throws rather than binding something unintended.
 */
export function resolveDefaults(
  argv: string[],
  env: Record<string, string | undefined>,
): ResolvedDefaults {
  const flags = new Map<string, string>();
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    // no positionals in this CLI: refuse rather than ignore an unparsed token
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!VALUE_FLAGS.has(name)) {
      throw new Error(`unknown flag: --${name}`);
    }
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) {
        throw new Error(`flag --${name} needs a value`);
      }
    }
    if (value === "") {
      throw new Error(`flag --${name} needs a value`);
    }
    flags.set(name, value);
  }

  const flagPort = flags.get("port");
  const port =
    flagPort !== undefined
      ? parsePort(flagPort, "--port")
      : env.UIPI_PORT !== undefined
        ? parsePort(env.UIPI_PORT, "UIPI_PORT")
        : DEFAULT_PORT;

  const flagHost = flags.get("host");
  const host =
    flagHost !== undefined
      ? parseHost(flagHost, "--host")
      : env.UIPI_HOST !== undefined
        ? parseHost(env.UIPI_HOST, "UIPI_HOST")
        : DEFAULT_HOST;

  const staticOverride = flags.get("static") ?? env.UIPI_STATIC;
  const staticDir = staticOverride === undefined ? "" : expandPath(staticOverride, env);

  const cwd = flags.get("cwd") ?? env.UIPI_CWD ?? process.cwd();
  const agentDir = flags.get("agent-dir") ?? env.UIPI_AGENT_DIR ?? getAgentDir();
  return {
    port,
    host,
    staticDir,
    cwd: expandPath(cwd, env),
    agentDir: expandPath(agentDir, env),
    help,
  };
}

/** Resolve the defaults, or print the resolver's complaint and exit 2. */
function startupDefaults(): ResolvedDefaults {
  try {
    return resolveDefaults(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

function main(): void {
  const defaults = startupDefaults();
  if (defaults.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // the pure resolver returns "" for "unset"; the built-in default lives beside
  // this module, so resolve it here where `here` is known
  const staticDir =
    defaults.staticDir === "" ? path.resolve(here, "../../web/dist") : defaults.staticDir;

  // logged, and both dirs are handed to SessionService below as the fallbacks a
  // request that names neither cwd nor agent dir resolves against
  console.log(
    `defaults: port=${defaults.port} host=${defaults.host} staticDir=${staticDir} ` +
      `cwd=${defaults.cwd} agentDir=${defaults.agentDir}`,
  );

  const service = new SessionService(createAgentSessionRuntime, {
    cwd: defaults.cwd,
    agentDir: defaults.agentDir,
  });
  const { httpServer } = createServer({ port: defaults.port, staticDir }, service);
  // arm the resolved agent dir's scheduler now, so cron jobs fire without a client;
  // stop it on shutdown so the pending timer never holds the process open
  const scheduler = service.startSchedules(defaults.agentDir);

  const shutdown = async () => {
    scheduler.stop();
    await service.shutdown();
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  httpServer.listen(defaults.port, defaults.host, () => {
    console.log(
      `uipi server → http://${defaults.host === "0.0.0.0" ? "127.0.0.1" : defaults.host}:${defaults.port}  (ws /ws)`,
    );
  });
}

// only boot as the entry point, so importing `resolveDefaults` (from a test or a
// probe) never starts a server
const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main();
}
