import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks } from "@opencode-ai/plugin"
import plugin from "../src/index.js"

const directories: string[] = []

const session = (id: string, directory: string) => ({
  id,
  projectID: "project-1",
  directory,
  title: "New session",
  version: "1.17.18",
  time: { created: Date.now(), updated: Date.now() },
})

const createHooks = (
  options: Record<string, unknown>,
  log: () => Promise<unknown> = async () => ({}),
  directory = process.cwd(),
) => plugin.server({ client: { app: { log } }, directory } as never, options)

const sendMessage = async (hooks: Hooks, sessionID: string) => {
  const output = {
    message: { id: `msg_${sessionID}`, role: "user" },
    parts: [
      {
        id: `prt_prompt_${sessionID}`,
        sessionID,
        messageID: `msg_${sessionID}`,
        type: "text" as const,
        text: "hello",
      },
    ],
  }
  await hooks["chat.message"]?.({ sessionID }, output as never)
  return output.parts
}

const fireSessionCreated = (hooks: Hooks, id: string, directory: string, parentID?: string) => {
  void hooks.event?.({
    event: {
      type: "session.created",
      properties: { info: { ...session(id, directory), parentID } },
    },
  })
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("opencode-session-start", () => {
  test("waits for fire-and-forget startup and injects output into the immediate first message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    directories.push(directory)
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { "dev:start": "sleep 0.05; printf 'started'" } }),
    )

    const hooks = await createHooks({ injectOutput: true, verbosity: "silent" })
    fireSessionCreated(hooks, "session-1", directory)
    const parts = await sendMessage(hooks, "session-1")

    expect(parts).toHaveLength(2)
    expect(parts[1]?.text).toStartWith("[opencode-session-start] bun run dev:start exited with code 0\nstarted")
    expect(parts[1]).toMatchObject({ type: "text", synthetic: true, sessionID: "session-1" })
  })

  test("immediate creation and message run once and only inject into the first message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    directories.push(directory)
    const runsFile = join(directory, "runs")
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { "dev:start": `printf run >> ${JSON.stringify(runsFile)}` } }),
    )

    const hooks = await createHooks({ injectOutput: true, verbosity: "silent" })
    fireSessionCreated(hooks, "session-1", directory)
    fireSessionCreated(hooks, "session-1", directory)
    expect(await sendMessage(hooks, "session-1")).toHaveLength(2)
    expect(await sendMessage(hooks, "session-1")).toHaveLength(1)
    expect(await Bun.file(runsFile).text()).toBe("run")
  })

  test("starts newly created child sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    directories.push(directory)
    const runsFile = join(directory, "runs")
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { "dev:start": `printf run > ${JSON.stringify(runsFile)}` } }),
    )

    const hooks = await createHooks({ injectOutput: true, verbosity: "silent" })
    fireSessionCreated(hooks, "child", directory, "parent")
    expect(await sendMessage(hooks, "child")).toHaveLength(2)
    expect(await Bun.file(runsFile).text()).toBe("run")
  })

  test("starts a resumed existing session on its first message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    directories.push(directory)
    const runsFile = join(directory, "runs")
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { "dev:start": `printf run >> ${JSON.stringify(runsFile)}` } }),
    )

    const hooks = await createHooks({ injectOutput: true, verbosity: "silent" }, undefined, directory)
    expect(await sendMessage(hooks, "resumed-session")).toHaveLength(2)
    expect(await sendMessage(hooks, "resumed-session")).toHaveLength(1)
    expect(await Bun.file(runsFile).text()).toBe("run")
  })

  test("starts separate session IDs independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    directories.push(directory)
    const runsFile = join(directory, "runs")
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { "dev:start": `printf run >> ${JSON.stringify(runsFile)}` } }),
    )

    const hooks = await createHooks({ injectOutput: true, verbosity: "silent" }, undefined, directory)
    expect(await sendMessage(hooks, "session-1")).toHaveLength(2)
    expect(await sendMessage(hooks, "session-2")).toHaveLength(2)
    expect(await Bun.file(runsFile).text()).toBe("runrun")
  })

  test("does nothing when disabled or dev:start is absent", async () => {
    const disabledDirectory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    const missingDirectory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    directories.push(disabledDirectory, missingDirectory)
    await writeFile(
      join(disabledDirectory, "package.json"),
      JSON.stringify({ scripts: { "dev:start": "touch should-not-exist" } }),
    )
    await writeFile(join(missingDirectory, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))

    const disabledHooks = await createHooks({ enabled: false, injectOutput: true, verbosity: "silent" })
    fireSessionCreated(disabledHooks, "disabled", disabledDirectory)
    expect(await sendMessage(disabledHooks, "disabled")).toHaveLength(1)
    expect(await Bun.file(join(disabledDirectory, "should-not-exist")).exists()).toBe(false)

    const missingHooks = await createHooks({ injectOutput: true, verbosity: "silent" })
    fireSessionCreated(missingHooks, "missing", missingDirectory)
    expect(await sendMessage(missingHooks, "missing")).toHaveLength(1)
  })

  test("waits for startup without injecting when injectOutput is off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    directories.push(directory)
    const startedFile = join(directory, "started")
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { "dev:start": `sleep 0.05; touch ${JSON.stringify(startedFile)}` } }),
    )

    const hooks = await createHooks({ injectOutput: false, verbosity: "silent" })
    fireSessionCreated(hooks, "session-1", directory)
    expect(await sendMessage(hooks, "session-1")).toHaveLength(1)
    expect(await Bun.file(startedFile).exists()).toBe(true)
  })

  test("injects stdout, stderr, and a nonzero exit without failing the message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    directories.push(directory)
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { "dev:start": "printf out; printf err >&2; exit 7" } }),
    )

    const hooks = await createHooks({ injectOutput: true, verbosity: "silent" })
    fireSessionCreated(hooks, "session-1", directory)
    const parts = await sendMessage(hooks, "session-1")

    expect(parts[1]?.text).toStartWith("[opencode-session-start] bun run dev:start exited with code 7\nout")
    expect(parts[1]?.text).toContain("err")
  })

  test("logger failures do not fail or delay startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-session-start-"))
    directories.push(directory)
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { "dev:start": "printf started" } }))

    const hooks = await createHooks({ injectOutput: true, verbosity: "normal" }, () =>
      Promise.reject(new Error("logger unavailable")),
    )
    fireSessionCreated(hooks, "session-1", directory)
    expect((await sendMessage(hooks, "session-1"))[1]?.text).toContain("\nstarted")
  })
})
