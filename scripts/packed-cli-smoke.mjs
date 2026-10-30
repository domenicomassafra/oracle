import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = process.cwd();
// Exercise both spaces and literal percent signs (which cmd.exe expands even inside quotes).
const tmpRoot = mkdtempSync(join(tmpdir(), "oracle packed %OS% "));
const isWindows = process.platform === "win32";

function launch(command, args = []) {
  if (!isWindows) return { command, args };

  // The pnpm/action-setup runner can install pnpm.cmd without pnpm.ps1.
  // Invoke package-manager JavaScript entrypoints with Node and literal argv.
  if (command === "pnpm" || command === "npm") {
    const candidates =
      command === "pnpm"
        ? [
            process.env.npm_execpath,
            process.env.PNPM_HOME && join(process.env.PNPM_HOME, "..", "pnpm", "bin", "pnpm.cjs"),
          ]
        : [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
    const entrypoint = candidates.find(
      (candidate) => candidate && /\.(?:c|m)?js$/i.test(candidate) && existsSync(candidate),
    );
    if (!entrypoint) throw new Error(`Missing Windows package-manager entrypoint: ${command}`);
    return { command: process.execPath, args: [entrypoint, ...args] };
  }

  // npm creates .ps1 wrappers alongside .cmd on Windows. -File receives argv
  // directly, so percent signs and whitespace never pass through cmd expansion.
  const shim =
    command.includes("\\") || command.includes("/")
      ? command.replace(/\.cmd$/i, ".ps1")
      : undefined;
  if (!shim || !existsSync(shim)) throw new Error(`Missing Windows PowerShell shim: ${command}`);
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", shim, ...args],
  };
}

function run(command, args, options = {}) {
  const invocation = launch(command, args);
  try {
    return execFileSync(invocation.command, invocation.args, {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 240_000,
    });
  } catch (error) {
    error.message = `${command} ${args[0] ?? ""}: ${error.message}`;
    throw error;
  }
}

async function verifyMcpShim(command, cwd) {
  const invocation = launch(command);
  const client = new Client({ name: "oracle-packed-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    ...invocation,
    cwd,
    stderr: "pipe",
    env: { ...process.env, ORACLE_DISABLE_KEYTAR: "1", ORACLE_HOME_DIR: join(tmpRoot, "home") },
  });
  const timeout = { timeout: 10_000 };
  try {
    // connect() performs the MCP stdio initialize handshake.
    await client.connect(transport, timeout);
    const result = await client.listTools({}, timeout);
    assert.ok(
      result.tools.some((tool) => tool.name === "sessions"),
      "packed MCP tools/list omitted sessions",
    );
  } finally {
    await client.close();
  }
}

let smokeFailure;
try {
  console.log("Packed CLI smoke: pack");
  run("pnpm", ["pack", "--pack-destination", tmpRoot]);
  const tarball = readdirSync(tmpRoot).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) {
    throw new Error("pnpm pack did not produce a .tgz file");
  }

  const installDir = join(tmpRoot, "install");
  mkdirSync(installDir);
  console.log("Packed CLI smoke: npm install");
  run("npm", ["init", "-y"], { cwd: installDir });
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(tmpRoot, tarball)], {
    cwd: installDir,
    timeout: 600_000,
  });
  const binDir = join(installDir, "node_modules", ".bin");
  const shimSuffix = isWindows ? ".ps1" : "";
  const cliPath = join(binDir, `oracle${shimSuffix}`);
  accessSync(cliPath, isWindows ? constants.F_OK : constants.X_OK);
  const mcpPath = join(binDir, `oracle-mcp${shimSuffix}`);
  accessSync(mcpPath, isWindows ? constants.F_OK : constants.X_OK);
  if (isWindows) {
    accessSync(join(binDir, "oracle.cmd"), constants.F_OK);
    accessSync(join(binDir, "oracle-mcp.cmd"), constants.F_OK);
  }
  console.log("Packed CLI smoke: installed CLI help");
  const help = run(cliPath, ["--help", "--verbose"], { cwd: installDir });

  for (const expected of [
    "--no-azure",
    "--provider <provider>",
    "--http-timeout",
    "--allow-partial",
    "--preflight",
    "docs",
  ]) {
    if (!help.includes(expected)) {
      throw new Error(`packed CLI help is missing ${expected}`);
    }
  }
  console.log("Packed CLI smoke: installed MCP stdio handshake");
  await verifyMcpShim(mcpPath, installDir);
  console.log("Packed CLI help and MCP handshake smoke: ok");
} catch (error) {
  smokeFailure = error;
  throw error;
} finally {
  try {
    // Windows may retain a just-closed shim or npm file handle briefly.
    rmSync(tmpRoot, {
      recursive: true,
      force: true,
      maxRetries: isWindows ? 30 : 0,
      retryDelay: 500,
    });
  } catch (cleanupError) {
    if (!smokeFailure) throw cleanupError;
    // Do not hide the original pack/install/CLI/MCP failure behind EPERM.
    console.error(`Packed CLI smoke cleanup also failed: ${cleanupError}`);
  }
}
