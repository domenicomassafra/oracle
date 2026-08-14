import { describe, expect, test } from "vitest";
import {
  accountRoleFor,
  providerAdapterFor,
  providerForModel,
  providerReceiptForAccount,
  redactProfileKey,
  resolveBrowserAccount,
} from "../src/accounts.js";
import type { UserConfig } from "../src/config.js";

const config: UserConfig = {
  accountPool: {
    defaults: { chatgpt: "primary-chatgpt", gemini: "primary-gemini" },
    groups: {
      text: ["primary-chatgpt", "primary-gemini", "text-only-gemini"],
      image: ["primary-chatgpt", "primary-gemini"],
    },
    accounts: {
      "primary-chatgpt": {
        providers: ["chatgpt"],
        profile: "primary-chatgpt",
        profileDir: "/profiles/chatgpt-primary",
        capabilities: ["text", "image"],
      },
      "primary-gemini": {
        providers: ["gemini"],
        profile: "primary-gemini",
        profileDir: "/profiles/gemini-primary",
        capabilities: ["text", "image"],
      },
      "text-only-gemini": {
        providers: ["gemini"],
        profile: "reader",
        profileDir: "/profiles/gemini-text",
        capabilities: ["text"],
      },
    },
  },
};

describe("Oracle browser accounts", () => {
  test.each([
    ["gpt-5.6-sol", "chatgpt"],
    ["gemini-3.6-flash", "gemini"],
    ["claude-sonnet-5", "claude"],
    ["grok-4.1", "grok"],
  ])("maps %s to %s", (model, provider) => expect(providerForModel(model)).toBe(provider));

  test("selects the provider default deterministically", () => {
    expect(
      resolveBrowserAccount({ config, model: "gemini-3.6-flash", capability: "image" }),
    ).toMatchObject({ id: "primary-gemini", provider: "gemini" });
  });

  test("selects two distinct named accounts", () => {
    const primary = resolveBrowserAccount({
      config,
      model: "gemini-3.6-flash",
      requestedAccount: "primary-gemini",
      capability: "text",
    });
    const secondary = resolveBrowserAccount({
      config,
      model: "gemini-3.6-flash",
      requestedAccount: "text-only-gemini",
      capability: "text",
    });
    expect(primary?.profileDir).not.toBe(secondary?.profileDir);
  });

  test("selects an account by owner-facing profile", () => {
    expect(
      resolveBrowserAccount({
        config,
        model: "gemini-3.6-flash",
        requestedProfile: "reader",
        capability: "text",
      }),
    ).toMatchObject({ id: "text-only-gemini", profile: "reader" });
  });

  test("rejects image generation for a text-only account", () => {
    expect(() =>
      resolveBrowserAccount({
        config,
        model: "gemini-3.6-flash",
        requestedAccount: "text-only-gemini",
        capability: "image",
      }),
    ).toThrow(/not allowed for image/);
  });

  test("rejects an account excluded from a capability group", () => {
    const groupRestricted: UserConfig = {
      accountPool: {
        defaults: { gemini: "one" },
        groups: { text: [] },
        accounts: {
          one: { providers: ["gemini"], profileDir: "/one", capabilities: ["text"] },
        },
      },
    };
    expect(() =>
      resolveBrowserAccount({
        config: groupRestricted,
        model: "gemini-3.6-flash",
        capability: "text",
      }),
    ).toThrow(/not a member of the text group/);
  });

  test("rejects provider/account mismatches", () => {
    expect(() =>
      resolveBrowserAccount({
        config,
        model: "gpt-5.6-sol",
        requestedAccount: "primary-gemini",
        capability: "text",
      }),
    ).toThrow(/does not provide chatgpt/);
  });

  test("rejects an unknown profile before browser launch", () => {
    expect(() =>
      resolveBrowserAccount({
        config,
        model: "gemini-3.6-flash",
        requestedProfile: "missing",
        capability: "text",
      }),
    ).toThrow(/No Oracle browser account is mapped to profile/);
  });

  test("rejects combined account and profile selection", () => {
    expect(() =>
      resolveBrowserAccount({
        config,
        model: "gemini-3.6-flash",
        requestedAccount: "primary-gemini",
        requestedProfile: "reader",
        capability: "text",
      }),
    ).toThrow(/either an Oracle account or profile/);
  });

  test("rejects two account ids sharing one browser profile", () => {
    const duplicated: UserConfig = {
      accountPool: {
        defaults: { gemini: "one" },
        accounts: {
          one: { providers: ["gemini"], profileDir: "/same", capabilities: ["text"] },
          two: { providers: ["gemini"], profileDir: "/same", capabilities: ["text"] },
        },
      },
    };
    expect(() =>
      resolveBrowserAccount({
        config: duplicated,
        model: "gemini-3.6-flash",
        capability: "text",
      }),
    ).toThrow(/cannot share one Chrome profile/);
  });

  test("allows distinct named Chrome profiles in one user-data directory", () => {
    const sharedRoot: UserConfig = {
      accountPool: {
        defaults: { claude: "claude" },
        accounts: {
          chatgpt: {
            providers: ["chatgpt"],
            profileDir: "/profiles/shared",
            capabilities: ["text"],
          },
          claude: {
            providers: ["claude"],
            profileDir: "/profiles/shared",
            chromeProfile: "Profile 1",
            capabilities: ["text"],
          },
        },
      },
    };
    expect(
      resolveBrowserAccount({ config: sharedRoot, model: "claude-sonnet-5", capability: "text" }),
    ).toMatchObject({ chromeProfile: "Profile 1" });
  });

  test("rejects a Chrome profile path", () => {
    const invalid: UserConfig = {
      accountPool: {
        defaults: { chatgpt: "one" },
        accounts: {
          one: {
            providers: ["chatgpt"],
            profileDir: "/one",
            chromeProfile: "../other",
            capabilities: ["text"],
          },
        },
      },
    };
    expect(() =>
      resolveBrowserAccount({ config: invalid, model: "gpt-5.6-sol", capability: "text" }),
    ).toThrow(/must be a Chrome profile name/);
  });

  test("maps every provider to its own real browser adapter", () => {
    expect(providerAdapterFor("chatgpt")).toBe("chatgpt-browser");
    expect(providerAdapterFor("gemini")).toBe("gemini-browser");
    expect(providerAdapterFor("claude")).toBe("claude-browser");
    expect(providerAdapterFor("grok")).toBe("grok-browser");
  });

  test("redacted profile keys are stable and never contain account identity", () => {
    const first = redactProfileKey("/profiles/chatgpt-primary", null);
    const second = redactProfileKey("/profiles/chatgpt-primary", "Default");
    expect(first).toBe(second);
    expect(first).toMatch(/^pk-[0-9a-f]{12}$/);
    expect(first).not.toContain("chatgpt");
    expect(first).not.toContain("/profiles");
    const other = redactProfileKey("/profiles/gemini-primary", null);
    expect(other).not.toBe(first);
  });

  test("provider receipt carries provider, adapter, role, redacted key and capability", () => {
    const account = resolveBrowserAccount({
      config,
      model: "gpt-5.6-sol",
      capability: "image",
    });
    expect(account).not.toBeNull();
    const receipt = providerReceiptForAccount({
      model: "gpt-5.6-sol",
      account,
      capability: "image",
    });
    expect(receipt.provider).toBe("chatgpt");
    expect(receipt.adapter).toBe("chatgpt-browser");
    expect(receipt.accountRole).toBe("primary");
    expect(receipt.profileKey).toMatch(/^pk-[0-9a-f]{12}$/);
    expect(receipt.capability).toBe("image");
    expect(JSON.stringify(receipt)).not.toContain("/profiles");
    expect(JSON.stringify(receipt)).not.toContain("primary-chatgpt");
  });

  test("provider receipt uses the model family when no account is resolved", () => {
    const receipt = providerReceiptForAccount({
      model: "grok-4.1",
      account: null,
      capability: "text",
    });
    expect(receipt.provider).toBe("grok");
    expect(receipt.adapter).toBe("grok-browser");
    expect(receipt.accountRole).toBe("none");
    expect(receipt.profileKey).toBe("none");
  });

  test("account role defaults to primary and never leaks the profile name", () => {
    expect(accountRoleFor(null)).toBe("primary");
    const account = resolveBrowserAccount({
      config,
      model: "gemini-3.6-flash",
      capability: "text",
    });
    expect(accountRoleFor(account)).toBe("primary");
  });
});
