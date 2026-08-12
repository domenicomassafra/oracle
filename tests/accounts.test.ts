import { describe, expect, test } from "vitest";
import { providerForModel, resolveBrowserAccount } from "../src/accounts.js";
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
        profileDir: "/profiles/chatgpt-primary",
        capabilities: ["text", "image"],
      },
      "primary-gemini": {
        providers: ["gemini"],
        profileDir: "/profiles/gemini-primary",
        capabilities: ["text", "image"],
      },
      "text-only-gemini": {
        providers: ["gemini"],
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
    ).toThrow(/cannot share one profile/);
  });
});
