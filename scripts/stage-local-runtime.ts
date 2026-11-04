#!/usr/bin/env node
// Stages apps/server/dist plus the release archive's runtime externals, run by the host's Node,
// for Linux hosts that skip the single-executable build and the resource monitor.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { CliArchiveInputMissingError, stageRuntimeExternals } from "./build-cli-archive.ts";

const stageLocalRuntime = Effect.fn("stageLocalRuntime")(function* (input: {
  readonly outDir: string;
  readonly version: string;
  readonly node: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const serverDist = path.join(repoRoot, "apps/server/dist");
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  if (platform !== "linux" || (arch !== "arm64" && arch !== "x64")) {
    return yield* new CliArchiveInputMissingError({
      inputPath: `${platform}-${arch}`,
      hint: "Local runtime staging supports Linux on arm64 or x64.",
    });
  }
  for (const required of ["bin.mjs", "client/index.html"]) {
    if (!(yield* fs.exists(path.join(serverDist, required)))) {
      return yield* new CliArchiveInputMissingError({
        inputPath: path.join(serverDist, required),
        hint: "Run `vp run --filter t3 build` first.",
      });
    }
  }

  yield* fs.remove(input.outDir, { recursive: true, force: true });
  yield* fs.makeDirectory(input.outDir, { recursive: true });
  yield* fs.copy(serverDist, path.join(input.outDir, "dist"));
  // Absolute node path: the service runs with a minimal PATH.
  yield* fs.writeFileString(
    path.join(input.outDir, "t3"),
    `#!/bin/sh\nexec "${input.node}" "$(dirname "$0")/dist/bin.mjs" "$@"\n`,
  );
  yield* fs.chmod(path.join(input.outDir, "t3"), 0o755);
  yield* stageRuntimeExternals({
    repoRoot,
    stageDir: input.outDir,
    platform: "linux",
    arch,
    version: input.version,
  });
  yield* Effect.log(`[stage-local-runtime] Staged ${input.version} in ${input.outDir}`);
});

const command = Command.make(
  "stage-local-runtime",
  {
    outDir: Flag.String("out-dir"),
    version: Flag.String("version"),
    node: Flag.String("node").pipe(
      Flag.withDescription("Absolute path of the node binary the runtime runs on."),
    ),
  },
  (input) => stageLocalRuntime(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Stage apps/server/dist as a local pinned runtime directory."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
