import {
  DEFAULT_SCHEDULED_TASK_CHECK_TIMEOUT_SECONDS,
  type ProjectId,
  type ScheduledTaskCheck,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";

const MAX_CHECK_OUTPUT_CHARS = 20_000;

export interface ScheduledTaskCheckOutcome {
  readonly exitCode: number | null;
  readonly output: string;
  readonly error: string | null;
}

export interface ScheduledTaskCheckRunnerShape {
  readonly run: (input: {
    readonly projectId: ProjectId;
    readonly check: ScheduledTaskCheck;
  }) => Effect.Effect<ScheduledTaskCheckOutcome>;
}

export class ScheduledTaskCheckRunner extends Context.Reference<ScheduledTaskCheckRunnerShape>(
  "t3/scheduledTasks/ScheduledTaskCheckRunner",
  {
    defaultValue: () => ({
      run: () =>
        Effect.succeed({
          exitCode: null,
          output: "",
          error: "This server can't run scheduled task checks.",
        }),
    }),
  },
) {}

function shellInvocation(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  return platform === "win32"
    ? { command: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { command: "/bin/sh", args: ["-c", command] };
}

function combinedOutput(stdout: string, stderr: string): string {
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0).join("\n");
  return output.length > MAX_CHECK_OUTPUT_CHARS
    ? `${output.slice(0, MAX_CHECK_OUTPUT_CHARS)}\n… (output truncated)`
    : output;
}

export const layer = Layer.effect(
  ScheduledTaskCheckRunner,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const projects = yield* ProjectService.ProjectService;
    const platform = yield* HostProcess.Platform;
    const env = yield* HostProcess.Environment;
    return {
      run: Effect.fn("ScheduledTaskCheckRunner.run")(
        function* ({ projectId, check }) {
          const project = yield* projects.getById(projectId);
          if (Option.isNone(project)) {
            return { exitCode: null, output: "", error: "The task's project no longer exists." };
          }
          const timeoutSeconds =
            check.timeoutSeconds ?? DEFAULT_SCHEDULED_TASK_CHECK_TIMEOUT_SECONDS;
          const result = yield* runner.run({
            ...shellInvocation(check.command, platform, env),
            cwd: project.value.workspaceRoot,
            timeout: `${timeoutSeconds} seconds`,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: MAX_CHECK_OUTPUT_CHARS * 4,
            outputMode: "truncate",
          });
          const output = combinedOutput(result.stdout, result.stderr);
          if (result.timedOut) {
            return {
              exitCode: null,
              output,
              error: `The check timed out after ${timeoutSeconds}s.`,
            };
          }
          if (result.code === null) {
            return { exitCode: null, output, error: "The check was stopped before it exited." };
          }
          return { exitCode: Number(result.code), output, error: null };
        },
        (effect) =>
          effect.pipe(
            Effect.catch((cause) =>
              Effect.succeed({
                exitCode: null,
                output: "",
                error: `The check could not run: ${cause.message}`,
              }),
            ),
          ),
      ),
    } satisfies ScheduledTaskCheckRunnerShape;
  }),
);
