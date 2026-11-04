import { describe, expect, it } from "vite-plus/test";

import {
  checkDraft,
  checkDraftChanged,
  emptyCheckRuleDraft,
  parseCheckDraft,
  type ScheduledTaskCheckDraft,
} from "./scheduledTaskCheck.ts";

const draft = (overrides: Partial<ScheduledTaskCheckDraft> = {}): ScheduledTaskCheckDraft => ({
  enabled: true,
  command: "glass next --check",
  timeoutSeconds: "",
  rules: [
    { id: "a", exitCode: "10", prompt: " Claim it " },
    { id: "b", exitCode: "0", prompt: "" },
  ],
  ...overrides,
});

describe("scheduled task check drafts", () => {
  it("round-trips a stored check, leaving blank prompts and timeouts to the server", () => {
    const parsed = parseCheckDraft(draft());
    expect(parsed).toEqual({
      check: {
        command: "glass next --check",
        rules: [{ exitCode: 10, prompt: "Claim it" }, { exitCode: 0 }],
      },
    });
    if (!("check" in parsed) || parsed.check === null) return;
    const reopened = checkDraft(parsed.check);
    expect(parseCheckDraft(reopened)).toEqual(parsed);
    expect(checkDraftChanged(reopened, checkDraft(parsed.check))).toBe(false);
  });

  it("clears a check that was turned off, whatever its fields hold", () => {
    expect(parseCheckDraft(draft({ enabled: false, command: "" }))).toEqual({ check: null });
  });

  it("names the field that would not save", () => {
    expect(parseCheckDraft(draft({ command: "  " }))).toEqual({
      error: "Enter the command to run.",
    });
    expect(parseCheckDraft(draft({ timeoutSeconds: "1.5" }))).toMatchObject({
      error: expect.stringContaining("timeout"),
    });
    expect(parseCheckDraft(draft({ rules: [{ id: "a", exitCode: "256", prompt: "" }] }))).toEqual({
      error: "Rule 1 needs an exit code from 0 to 255.",
    });
    expect(
      parseCheckDraft(
        draft({
          rules: [
            { id: "a", exitCode: "0", prompt: "" },
            { id: "b", exitCode: " 0", prompt: "x" },
          ],
        }),
      ),
    ).toEqual({ error: "Each exit code can have only one rule." });
    expect(parseCheckDraft(draft({ rules: [] }))).toMatchObject({ error: expect.any(String) });
  });

  it("treats a check that stays off as unchanged, so the save leaves it out", () => {
    const off = checkDraft(undefined);
    expect(checkDraftChanged(off, { ...off, command: "typed then turned off" })).toBe(false);
    expect(checkDraftChanged(off, { ...off, enabled: true })).toBe(true);
  });

  it("suggests the lowest exit code that has no rule yet", () => {
    expect(emptyCheckRuleDraft(draft().rules).exitCode).toBe("1");
  });
});
