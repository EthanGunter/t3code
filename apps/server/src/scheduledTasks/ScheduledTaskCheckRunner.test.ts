import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskCheckRunner from "./ScheduledTaskCheckRunner.ts";

const projectId = ProjectId.make("project:check");

const runnerIn = (workspaceRoot: string) =>
  ScheduledTaskCheckRunner.layer.pipe(
    Layer.provide(ProcessRunner.layer),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId ? Option.some({ workspaceRoot } as never) : Option.none(),
          ),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

// The commands are POSIX shell; cmd.exe runs them differently.
it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "runs the command in the project folder and reports its exit code and output",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${root}/queue`, "id-7f3a\n");
      const runner = yield* ScheduledTaskCheckRunner.ScheduledTaskCheckRunner.pipe(
        Effect.provide(runnerIn(root)),
      );

      assert.deepStrictEqual(
        yield* runner.run({
          projectId,
          check: { command: "cat queue; echo warn >&2; exit 10", rules: [{ exitCode: 10 }] },
        }),
        { exitCode: 10, output: "id-7f3a\nwarn", error: null },
      );
      assert.deepStrictEqual(
        yield* runner.run({
          projectId,
          check: { command: "sleep 5", timeoutSeconds: 1, rules: [{ exitCode: 0 }] },
        }),
        { exitCode: null, output: "", error: "The check timed out after 1s." },
      );
      assert.deepStrictEqual(
        yield* runner.run({
          projectId: ProjectId.make("project:gone"),
          check: { command: "true", rules: [{ exitCode: 0 }] },
        }),
        { exitCode: null, output: "", error: "The task's project no longer exists." },
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
