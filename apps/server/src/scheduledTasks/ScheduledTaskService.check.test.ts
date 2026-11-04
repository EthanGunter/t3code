import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type ScheduledTaskCheck,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskCheckRunner from "./ScheduledTaskCheckRunner.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const taskInput = (
  id: string,
  overrides: Partial<ScheduledTaskUpsertInput> = {},
): ScheduledTaskUpsertInput => ({
  id: ScheduledTaskId.make(id),
  title: "Glass worker",
  prompt: "Do the work",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project:test"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  ...overrides,
});

const glassCheck: ScheduledTaskCheck = {
  command: "glass next --check",
  rules: [{ exitCode: 10, prompt: "Claim the work below" }, { exitCode: 0 }],
};

const makeLayer = (input: {
  readonly prompts: Ref.Ref<ReadonlyArray<string>>;
  readonly check: ScheduledTaskCheckRunner.ScheduledTaskCheckRunnerShape["run"];
  readonly scheduler?: boolean;
  readonly onLaunch?: Effect.Effect<void>;
}) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (launch) =>
            Ref.update(input.prompts, (prompts) => [
              ...prompts,
              launch.initialMessage?.text ?? "",
            ]).pipe(
              Effect.andThen(input.onLaunch ?? Effect.void),
              Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.succeed(ScheduledTaskCheckRunner.ScheduledTaskCheckRunner, { run: input.check }),
        NodeCrypto.layer,
        input.scheduler === true
          ? Scheduler.layer
          : Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
      ),
    ),
  );

it.effect("a check's exit code picks the prompt, and an unlisted exit code skips the run", () =>
  Effect.gen(function* () {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
    const outcomes = yield* Ref.make([
      { exitCode: 10, output: "id-7f3a", error: null },
      { exitCode: 3, output: "nothing to do", error: null },
      { exitCode: null, output: "", error: "The check timed out after 60s." },
    ]);
    const layer = makeLayer({
      prompts,
      check: () =>
        Ref.modify(outcomes, ([next, ...rest]) => [
          next ?? { exitCode: 0, output: "", error: null },
          rest,
        ]),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(taskInput("task:glass", { check: glassCheck }));

      const matched = yield* service.runNow({ id: task.id });
      assert.deepStrictEqual(yield* Ref.get(prompts), [
        "Claim the work below\n\nCheck output (exit 10):\n```\nid-7f3a\n```",
      ]);
      assert.equal(matched.task.lastCheck?.ran, true);
      assert.equal(matched.task.runCount, 1);

      const skipped = yield* service.runNow({ id: task.id });
      assert.lengthOf(yield* Ref.get(prompts), 1);
      assert.deepInclude(skipped.task.lastCheck, {
        exitCode: 3,
        output: "nothing to do",
        ran: false,
        error: null,
      });
      assert.equal(skipped.task.runCount, 1);
      assert.equal(skipped.task.lastRunStatus, "succeeded");

      const timedOut = yield* service.runNow({ id: task.id });
      assert.lengthOf(yield* Ref.get(prompts), 1);
      assert.deepInclude(timedOut.task.lastCheck, {
        exitCode: null,
        ran: false,
        error: "The check timed out after 60s.",
      });
      // Stored, not only returned: the list clients render shows the same result.
      const [listed] = (yield* service.list()).tasks;
      assert.deepStrictEqual(listed?.lastCheck, timedOut.task.lastCheck);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("saves keep a stored check unless they clear it, and webhook tasks refuse one", () =>
  Effect.gen(function* () {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = makeLayer({
      prompts,
      check: () => Effect.succeed({ exitCode: 3, output: "", error: null }),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const id = "task:keep";
      yield* service.upsert(taskInput(id, { check: glassCheck }));
      yield* service.runNow({ id: ScheduledTaskId.make(id) });

      // A client that predates checks sends no `check` field.
      const renamed = yield* service.upsert(taskInput(id, { title: "Renamed" }));
      assert.deepStrictEqual(renamed.task.check, glassCheck);
      assert.equal(renamed.task.lastCheck?.exitCode, 3);

      const cleared = yield* service.upsert(taskInput(id, { check: null }));
      assert.isUndefined(cleared.task.check);
      assert.isUndefined(cleared.task.lastCheck);

      const refused = yield* service
        .upsert(
          taskInput("task:webhook", {
            schedule: { type: "webhook" },
            check: glassCheck,
          }),
        )
        .pipe(Effect.flip);
      assert.include(refused.message, "Webhook tasks can't have a check");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a slow check does not hold up other due tasks, and a skip moves to the next time", () =>
  Effect.gen(function* () {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
    const checkStarted = yield* Deferred.make<void>();
    const releaseCheck = yield* Deferred.make<void>();
    const otherLaunched = yield* Deferred.make<void>();
    const layer = makeLayer({
      prompts,
      scheduler: true,
      onLaunch: Deferred.succeed(otherLaunched, undefined).pipe(Effect.asVoid),
      check: () =>
        Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
          Effect.as({ exitCode: 1, output: "", error: null }),
        ),
    });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task: checked } = yield* service.upsert(
        taskInput("task:a-checked", { check: glassCheck }),
      );
      yield* service.upsert(taskInput("task:b-plain", { prompt: "Plain run" }));

      yield* TestClock.adjust("65 seconds");
      yield* Deferred.await(checkStarted);
      // The plain task ran while the check was still going.
      yield* Deferred.await(otherLaunched);
      assert.deepStrictEqual(yield* Ref.get(prompts), ["Plain run"]);

      const recorded = yield* service.subscribeList().pipe(
        Stream.map(({ tasks }) => tasks.find((task) => task.id === checked.id)),
        Stream.filter((task) => task?.lastCheck !== undefined),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.succeed(releaseCheck, undefined);
      const skipped = yield* Fiber.join(recorded);
      assert.equal(skipped._tag, "Some");
      if (skipped._tag !== "Some" || skipped.value === undefined) return;
      assert.equal(skipped.value.lastCheck?.ran, false);
      assert.equal(skipped.value.runCount, 0);
      assert.isTrue((skipped.value.nextRunAt ?? "") > (checked.nextRunAt ?? ""));
      assert.deepStrictEqual(yield* Ref.get(prompts), ["Plain run"]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
