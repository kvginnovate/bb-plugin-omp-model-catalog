// bb-plugin-omp-model-catalog — host entry.
//
// The host side owns the real `omp` binary: `catalog` shells out to
// `omp models --json`, `omp --version`, and `omp config path` on the
// machine that invoked the call. The host stays a thin reader — it returns
// the RAW catalog; the server groups it into provider sections, so the host
// has zero knowledge of provider display rules.
import { spawn } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk/host";
import { catalogModelSchema, hostContract } from "./contract.js";
import type { CatalogModel } from "./contract.js";

/** The `omp` executable, resolved from PATH (on Windows that is `omp.exe`). */
const OMP_BINARY = "omp";

/**
 * One `omp` invocation costs a process spawn, and `models --json` is the slow
 * one. Cap every call so a wedged child cannot pin the worker forever.
 */
const CALL_TIMEOUT_MS = 60_000;

/**
 * Run one `omp` invocation and resolve with its stdout.
 *
 * `shell: false` plus an argv array means a value like `a:b c` can never be
 * interpreted by a shell. The 60 s cap kills a wedged child and settles,
 * and aborts kill and settle immediately so cancellation never hangs.
 */
function runOmp(args: readonly string[], signal: AbortSignal, label: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // `signal` makes Node kill the child on cancellation too; the listener
    // below settles first so the caller sees a clear "cancelled" error.
    const child = spawn(OMP_BINARY, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (error: Error | null, output: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(output);
    };
    const onAbort = (): void => {
      child.kill();
      settle(new Error(`omp ${label} was cancelled`), "");
    };
    timer = setTimeout(() => {
      // Settle here rather than waiting for `close`: a child that ignores the
      // kill must not leave the caller hanging.
      child.kill();
      settle(new Error(`omp ${label} timed out after ${CALL_TIMEOUT_MS} ms`), "");
    }, CALL_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => settle(new Error(`failed to run omp ${label}: ${error.message}`), ""));
    child.on("close", (code) => {
      if (code === 0) {
        settle(null, stdout);
        return;
      }
      // omp's own stderr carries the actionable text; surface it verbatim
      // rather than inventing a message.
      const detail = stderr.trim() || stdout.trim();
      settle(new Error(`omp ${label} exited with code ${code}${detail ? `: ${detail}` : ""}`), "");
    });

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

// `catalog` fans out three parallel `omp` calls. Serializing every call keeps
// two `catalog` invocations from stampeding the binary at once; it also keeps
// the module shape identical to the write-based host entries, so a future
// write path is a drop-in.
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`omp ${label} did not return JSON`);
  }
}

/** `omp models --json` → `{"models":[...]}`; one bad row is dropped, not fatal. */
async function readModels(signal: AbortSignal): Promise<CatalogModel[]> {
  const parsed = parseJson(await runOmp(["models", "--json"], signal, "models --json"), "models --json");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("omp models --json did not return a JSON object");
  }
  const rows = (parsed as { models?: unknown }).models;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) {
    throw new Error("omp models --json returned a non-array `models` field");
  }
  // The catalog is provider-authored; a row that fails validation must not
  // break the whole listing, so drop it and keep the rest.
  const models: CatalogModel[] = [];
  for (const row of rows) {
    const result = catalogModelSchema.safeParse(row);
    if (result.success) models.push(result.data);
  }
  return models;
}

async function readConfigPath(signal: AbortSignal): Promise<string> {
  return (await runOmp(["config", "path"], signal, "config path")).trim();
}

/** `omp --version` prints `omp/18.6.0`; the contract wants the bare version. */
function parseVersion(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "")?.trim() ?? "";
  const match = /^omp\/(.+)$/.exec(line);
  return match?.[1] ?? line;
}

async function readVersion(signal: AbortSignal): Promise<string> {
  return parseVersion(await runOmp(["--version"], signal, "--version"));
}

const handlers: ExperimentalHostRpcHandlers<typeof hostContract> = {
  async catalog(_input, context) {
    return serialize(async () => {
      const [version, configPath, models] = await Promise.all([
        readVersion(context.signal),
        readConfigPath(context.signal),
        readModels(context.signal),
      ]);
      return { version, configPath, models };
    });
  },
};

export default experimental_defineHostEntry({ contract: hostContract, handlers });
