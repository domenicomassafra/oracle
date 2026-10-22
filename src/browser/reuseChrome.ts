import type { LaunchedChrome } from "chrome-launcher";
import type { BrowserLogger } from "./types.js";
import { formatElapsed } from "../oracle/format.js";
import { delay } from "./utils.js";
import {
  cleanupStaleProfileState,
  findRunningChromeDebugTargetForProfile,
  readChromePid,
  readDevToolsPort,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";

export async function maybeReuseRunningChrome(
  userDataDir: string,
  logger: BrowserLogger,
  options: {
    waitForPortMs?: number;
    probe?: typeof verifyDevToolsReachable;
    chromePath?: string | null;
    discover?: typeof findRunningChromeDebugTargetForProfile;
  } = {},
): Promise<LaunchedChrome | null> {
  const discover = options.discover ?? findRunningChromeDebugTargetForProfile;
  const waitForPortMs = Math.max(0, options.waitForPortMs ?? 0);
  let port = await readDevToolsPort(userDataDir);
  if (!port && waitForPortMs > 0) {
    const deadline = Date.now() + waitForPortMs;
    logger(`Waiting up to ${formatElapsed(waitForPortMs)} for shared Chrome to appear...`);
    while (!port && Date.now() < deadline) {
      await delay(250);
      port = await readDevToolsPort(userDataDir);
    }
  }
  let pid = await readChromePid(userDataDir);
  if (!port) {
    const discovered = await discover(userDataDir);
    if (!discovered) {
      if (pid) {
        logger(
          `No reachable Chrome DevTools target found for ${userDataDir}; clearing stale profile state before launching new Chrome.`,
        );
        await cleanupStaleProfileState(userDataDir, logger, {
          lockRemovalMode: "if_oracle_pid_dead",
        });
      }
      return null;
    }
    const discoveredProbe = await (options.probe ?? verifyDevToolsReachable)({
      port: discovered.port,
    });
    if (!discoveredProbe.ok) {
      logger(
        `Discovered Chrome for ${userDataDir} on port ${discovered.port} but it was unreachable (${discoveredProbe.error}); launching new Chrome.`,
      );
      await cleanupStaleProfileState(userDataDir, logger, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      return null;
    }
    await writeDevToolsActivePort(userDataDir, discovered.port);
    await writeChromePid(userDataDir, discovered.pid);
    port = discovered.port;
    pid = discovered.pid;
    logger(
      `Discovered running Chrome for ${userDataDir}; reusing (DevTools port ${port}, pid ${pid})`,
    );
    return {
      port,
      pid,
      kill: async () => {},
      process: undefined,
    } as unknown as LaunchedChrome;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port });
  if (!probe.ok) {
    logger(
      `DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`,
    );
    // Safe cleanup: remove stale DevToolsActivePort; only remove lock files if this was an Oracle-owned pid that died.
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "if_oracle_pid_dead" });
    return null;
  }
  // A service/browser restart can retain the DevTools port while replacing the
  // browser PID. Keep the port (the actual attachment authority), but refresh
  // the recorded PID from the process that owns this exact profile. Otherwise
  // receipts incorrectly report a dead browser and later session recovery
  // marks a live conversation as a zombie.
  const discovered = await discover(userDataDir);
  if (discovered?.port === port && discovered.pid !== pid) {
    await writeChromePid(userDataDir, discovered.pid);
    pid = discovered.pid;
    logger(
      `Refreshed shared Chrome ownership for ${userDataDir}; reusing (DevTools port ${port}, pid ${pid})`,
    );
  }
  if (options.chromePath) {
    logger(
      `[browser] Warning: reusing Chrome already running for ${userDataDir}` +
        ` (pid ${pid ?? "unknown"}, port ${port}); configured executable ${options.chromePath}` +
        " applies only to a new launch. The running executable has not been verified against it." +
        " To switch browsers, finish active runs and close this profile’s Chrome, or use a different --browser-manual-login-profile-dir.",
    );
  }
  logger(
    `Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ""})`,
  );
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}
