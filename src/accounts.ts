import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { UserConfig } from "./config.js";

export type AccountCapability = "text" | "image";

export interface BrowserAccountConfig {
  providers: Array<"chatgpt" | "gemini" | "claude" | "grok">;
  /** Owner-facing name for the isolated Chrome profile; distinct from the account id. */
  profile?: string;
  /** Optional named Chrome profile within profileDir (for example, "Profile 1"). */
  chromeProfile?: string;
  profileDir: string;
  capabilities: AccountCapability[];
  /** Non-identifying role class used in receipts ("primary", "secondary", ...). */
  role?: string;
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
  profile: string | null;
  chromeProfile: string | null;
  profileDir: string;
  capabilities: AccountCapability[];
  role: string;
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

function resolveChromeProfile(profile: string | undefined): string | null {
  const trimmed = profile?.trim();
  if (!trimmed) return null;
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Oracle account chromeProfile must be a Chrome profile name, not a path.");
  }
  return trimmed;
}

export function resolveBrowserAccount(input: {
  config: UserConfig;
  model: string;
  requestedAccount?: string;
  requestedProfile?: string;
  capability: AccountCapability;
}): ResolvedBrowserAccount | null {
  const provider = providerForModel(input.model);
  const pool = input.config.accountPool;
  if (!pool?.accounts || Object.keys(pool.accounts).length === 0) {
    if (input.requestedAccount || input.requestedProfile) {
      throw new Error(
        `Oracle account pool is not configured; cannot select ${input.requestedAccount ?? input.requestedProfile}.`,
      );
    }
    return null;
  }
  if (input.requestedAccount?.trim() && input.requestedProfile?.trim()) {
    throw new Error("Choose either an Oracle account or profile, not both.");
  }
  const resolvedProfiles = new Map<string, string>();
  for (const [id, candidate] of Object.entries(pool.accounts)) {
    const resolved = resolveProfileDir(candidate.profileDir);
    const chromeProfile = resolveChromeProfile(candidate.chromeProfile) ?? "Default";
    const profileKey = `${resolved}\u0000${chromeProfile}`;
    const prior = resolvedProfiles.get(profileKey);
    if (prior && prior !== id) {
      throw new Error(
        `Oracle browser accounts ${prior} and ${id} cannot share one Chrome profile.`,
      );
    }
    resolvedProfiles.set(profileKey, id);
  }
  const requestedProfile = input.requestedProfile?.trim();
  const profileMatches = requestedProfile
    ? Object.entries(pool.accounts).filter(
        ([, candidate]) => candidate.profile === requestedProfile,
      )
    : [];
  if (requestedProfile && profileMatches.length === 0) {
    throw new Error(`No Oracle browser account is mapped to profile ${requestedProfile}.`);
  }
  if (requestedProfile && profileMatches.length > 1) {
    throw new Error(`Oracle profile ${requestedProfile} must map to exactly one account.`);
  }
  const accountId =
    input.requestedAccount?.trim() || profileMatches[0]?.[0] || pool.defaults?.[provider];
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
    profile: account.profile?.trim() || null,
    chromeProfile: resolveChromeProfile(account.chromeProfile),
    profileDir: resolveProfileDir(account.profileDir),
    capabilities: [...account.capabilities],
    role: account.role?.trim() || "primary",
  };
}

/** Real browser adapter name for a resolved provider. Never reused across providers. */
export function providerAdapterFor(provider: BrowserAccountConfig["providers"][number]): string {
  switch (provider) {
    case "chatgpt":
      return "chatgpt-browser";
    case "gemini":
      return "gemini-browser";
    case "claude":
      return "claude-browser";
    case "grok":
      return "grok-browser";
  }
}

/**
 * Redacted, stable profile key for receipts: a short SHA-256 of the resolved
 * profile directory plus the Chrome profile name. Never includes the account id.
 */
export function redactProfileKey(profileDir: string, chromeProfile: string | null): string {
  const digest = createHash("sha256")
    .update(`${path.resolve(profileDir)}\u0000${chromeProfile ?? "Default"}`)
    .digest("hex");
  return `pk-${digest.slice(0, 12)}`;
}

/**
 * Non-identifying account role label used in receipts. The account id (often an
 * email) and the owner-facing profile name are intentionally not part of the
 * returned value; only the configured role class ("primary", "secondary") is.
 */
export function accountRoleFor(account: ResolvedBrowserAccount | null): string {
  return account?.role ?? "primary";
}

/**
 * Redacted provider receipt for a single consult: provider, real adapter,
 * owner-facing account role and redacted profile key, plus capability.
 */
export function providerReceiptForAccount(input: {
  model: string;
  account: ResolvedBrowserAccount | null;
  capability: AccountCapability;
}): {
  provider: string;
  adapter: string;
  accountRole: string;
  profileKey: string;
  capability: AccountCapability;
} {
  const provider = input.account?.provider ?? providerForModel(input.model);
  return {
    provider,
    adapter: providerAdapterFor(provider),
    accountRole: input.account ? accountRoleFor(input.account) : "none",
    profileKey: input.account
      ? redactProfileKey(input.account.profileDir, input.account.chromeProfile)
      : "none",
    capability: input.capability,
  };
}
