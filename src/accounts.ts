import os from "node:os";
import path from "node:path";
import type { UserConfig } from "./config.js";

export type AccountCapability = "text" | "image";

export interface BrowserAccountConfig {
  providers: Array<"chatgpt" | "gemini" | "claude" | "grok">;
  profileDir: string;
  capabilities: AccountCapability[];
  enabled?: boolean;
}

export interface AccountPoolConfig {
  defaults?: Partial<Record<BrowserAccountConfig["providers"][number], string>>;
  groups?: Partial<Record<AccountCapability, string[]>>;
  accounts?: Record<string, BrowserAccountConfig>;
}

export interface ResolvedBrowserAccount {
  id: string;
  provider: BrowserAccountConfig["providers"][number];
  profileDir: string;
  capabilities: AccountCapability[];
}

export function providerForModel(model: string): BrowserAccountConfig["providers"][number] {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gemini")) return "gemini";
  if (normalized.startsWith("claude")) return "claude";
  if (normalized.startsWith("grok")) return "grok";
  return "chatgpt";
}

function resolveProfileDir(profileDir: string): string {
  const trimmed = profileDir.trim();
  if (!trimmed) throw new Error("Oracle account profileDir cannot be empty.");
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export function resolveBrowserAccount(input: {
  config: UserConfig;
  model: string;
  requestedAccount?: string;
  capability: AccountCapability;
}): ResolvedBrowserAccount | null {
  const provider = providerForModel(input.model);
  const pool = input.config.accountPool;
  if (!pool?.accounts || Object.keys(pool.accounts).length === 0) {
    if (input.requestedAccount) {
      throw new Error(
        `Oracle account pool is not configured; cannot select ${input.requestedAccount}.`,
      );
    }
    return null;
  }
  const resolvedProfiles = new Map<string, string>();
  for (const [id, candidate] of Object.entries(pool.accounts)) {
    const resolved = resolveProfileDir(candidate.profileDir);
    const prior = resolvedProfiles.get(resolved);
    if (prior && prior !== id) {
      throw new Error(
        `Oracle browser accounts ${prior} and ${id} cannot share one profile directory.`,
      );
    }
    resolvedProfiles.set(resolved, id);
  }
  const accountId = input.requestedAccount?.trim() || pool.defaults?.[provider];
  if (!accountId)
    throw new Error(`No default Oracle browser account is configured for ${provider}.`);
  const account = pool.accounts[accountId];
  if (!account || account.enabled === false) {
    throw new Error(`Oracle browser account ${accountId} is not available.`);
  }
  if (!account.providers.includes(provider)) {
    throw new Error(`Oracle browser account ${accountId} does not provide ${provider}.`);
  }
  if (!account.capabilities.includes(input.capability)) {
    throw new Error(
      `Oracle browser account ${accountId} is not allowed for ${input.capability} requests.`,
    );
  }
  const group = pool.groups?.[input.capability];
  if (group && !group.includes(accountId)) {
    throw new Error(
      `Oracle browser account ${accountId} is not a member of the ${input.capability} group.`,
    );
  }
  return {
    id: accountId,
    provider,
    profileDir: resolveProfileDir(account.profileDir),
    capabilities: [...account.capabilities],
  };
}
