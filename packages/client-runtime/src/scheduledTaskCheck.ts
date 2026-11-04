import {
  DEFAULT_SCHEDULED_TASK_CHECK_TIMEOUT_SECONDS,
  MAX_SCHEDULED_TASK_CHECK_RULES,
  MAX_SCHEDULED_TASK_CHECK_TIMEOUT_SECONDS,
  ScheduledTaskCheck,
  type ScheduledTaskCheckResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface ScheduledTaskCheckRuleDraft {
  /** Stable row identity for the form; never sent to the server. */
  readonly id: string;
  readonly exitCode: string;
  /** Blank sends the task's prompt. */
  readonly prompt: string;
}

export interface ScheduledTaskCheckDraft {
  readonly enabled: boolean;
  readonly command: string;
  /** Blank uses the server default. */
  readonly timeoutSeconds: string;
  readonly rules: ReadonlyArray<ScheduledTaskCheckRuleDraft>;
}

let lastRuleDraftId = 0;
const nextRuleDraftId = () => `check-rule-${++lastRuleDraftId}`;

export function emptyCheckRuleDraft(
  rules: ReadonlyArray<ScheduledTaskCheckRuleDraft> = [],
): ScheduledTaskCheckRuleDraft {
  const used = new Set(rules.map((rule) => rule.exitCode.trim()));
  let exitCode = 0;
  while (used.has(String(exitCode))) exitCode += 1;
  return { id: nextRuleDraftId(), exitCode: String(exitCode), prompt: "" };
}

/** By id, so a removed row's identity never passes to the row after it. */
export function removeCheckRuleDraft(
  rules: ReadonlyArray<ScheduledTaskCheckRuleDraft>,
  id: string,
): ReadonlyArray<ScheduledTaskCheckRuleDraft> {
  return rules.filter((rule) => rule.id !== id);
}

export function checkDraft(check: ScheduledTaskCheck | undefined): ScheduledTaskCheckDraft {
  if (check === undefined) {
    return { enabled: false, command: "", timeoutSeconds: "", rules: [emptyCheckRuleDraft()] };
  }
  return {
    enabled: true,
    command: check.command,
    timeoutSeconds: check.timeoutSeconds === undefined ? "" : String(check.timeoutSeconds),
    rules: check.rules.map((rule) => ({
      id: nextRuleDraftId(),
      exitCode: String(rule.exitCode),
      prompt: rule.prompt ?? "",
    })),
  };
}

const decodeCheck = Schema.decodeUnknownOption(ScheduledTaskCheck);

/**
 * Checks the draft with the server's own schema, so a draft that parses here
 * also saves. A turned-off draft parses to null, which clears a stored check.
 */
export function parseCheckDraft(
  draft: ScheduledTaskCheckDraft,
): { readonly check: ScheduledTaskCheck | null } | { readonly error: string } {
  if (!draft.enabled) return { check: null };
  const command = draft.command.trim();
  if (command === "") return { error: "Enter the command to run." };
  const timeout = draft.timeoutSeconds.trim();
  const timeoutSeconds = timeout === "" ? undefined : Number(timeout);
  if (
    timeoutSeconds !== undefined &&
    (!Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > MAX_SCHEDULED_TASK_CHECK_TIMEOUT_SECONDS)
  ) {
    return {
      error: `Enter a timeout in whole seconds from 1 to ${MAX_SCHEDULED_TASK_CHECK_TIMEOUT_SECONDS}, or leave it blank.`,
    };
  }
  if (draft.rules.length === 0) return { error: "Add a rule for the exit code that should run." };
  if (draft.rules.length > MAX_SCHEDULED_TASK_CHECK_RULES) {
    return { error: `Use at most ${MAX_SCHEDULED_TASK_CHECK_RULES} rules.` };
  }
  const rules = draft.rules.map((rule) => ({
    exitCode: rule.exitCode.trim() === "" ? Number.NaN : Number(rule.exitCode.trim()),
    prompt: rule.prompt.trim(),
  }));
  const badRule = rules.findIndex(
    (rule) => !Number.isInteger(rule.exitCode) || rule.exitCode < 0 || rule.exitCode > 255,
  );
  if (badRule !== -1) return { error: `Rule ${badRule + 1} needs an exit code from 0 to 255.` };
  if (new Set(rules.map((rule) => rule.exitCode)).size !== rules.length) {
    return { error: "Each exit code can have only one rule." };
  }
  const check = decodeCheck({
    command,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    rules: rules.map((rule) => ({
      exitCode: rule.exitCode,
      ...(rule.prompt === "" ? {} : { prompt: rule.prompt }),
    })),
  });
  if (Option.isNone(check)) return { error: "The command is too long." };
  return { check: check.value };
}

/**
 * Whether the form's check differs from the one it opened with. A save leaves
 * `check` out unless it did, so a client that can't set checks can still edit
 * the task, and editing only the title can't overwrite another device's check.
 */
export function checkDraftChanged(
  saved: ScheduledTaskCheckDraft,
  current: ScheduledTaskCheckDraft,
): boolean {
  if (saved.enabled !== current.enabled) return true;
  if (!current.enabled) return false;
  return (
    saved.command !== current.command ||
    saved.timeoutSeconds !== current.timeoutSeconds ||
    saved.rules.length !== current.rules.length ||
    saved.rules.some(
      (rule, index) =>
        rule.exitCode !== current.rules[index]?.exitCode ||
        rule.prompt !== current.rules[index]?.prompt,
    )
  );
}

export const CHECK_TIMEOUT_PLACEHOLDER = String(DEFAULT_SCHEDULED_TASK_CHECK_TIMEOUT_SECONDS);

export function checkResultLabel(result: ScheduledTaskCheckResult): string {
  if (result.error !== null) return `Check failed: ${result.error}`;
  return result.ran
    ? `Check exited ${result.exitCode}, ran`
    : `Check exited ${result.exitCode}, skipped`;
}
