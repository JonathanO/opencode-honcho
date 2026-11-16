import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Loads dist/server.js and dist/tui.js the way each OpenCode generation does and drives the
// v2 `setup()` against a recording context. No Honcho traffic: config has no API key, so the
// core skips network work but still registers every hook and tool.

// A shared `subscribe` models one server-wide stream feeding several instances.
const fakeContext = ({ directory = process.cwd(), subscribe } = {}) => {
  const hooks = { session: [], tool: [], shell: [] }
  const tools = []
  const subscribers = []
  const hook = (bucket) => async (name, callback) => {
    bucket.push({ name, callback })
    return { dispose: async () => {} }
  }
  const ctx = {
    app: { name: "opencode", version: "2.0.16", channel: "latest" },
    location: { directory, project: { id: "prj", directory, canonical: directory } },
    options: {},
    event: {
      subscribe:
        subscribe ??
        (({ signal } = {}) => ({
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise((resolve) => {
                  subscribers.push(resolve)
                  signal?.addEventListener("abort", () => resolve({ done: true }), { once: true })
                }),
            }
          },
        })),
    },
    session: {
      hook: hook(hooks.session),
      context: async () => [],
    },
    shell: { hook: hook(hooks.shell) },
    tool: {
      hook: hook(hooks.tool),
      transform: async (callback) => {
        callback({ add: (definition) => tools.push(definition), remove: () => {} })
        return { dispose: async () => {} }
      },
    },
  }
  const find = (bucket, name) => bucket.find((entry) => entry.name === name)?.callback
  const emit = async (type, data, location) => {
    while (subscribers.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const event = { type, data, created: Date.now(), ...(location ? { location: { directory: location } } : {}) }
    subscribers.shift()({ value: event, done: false })
  }
  return { ctx, hooks, tools, find, emit }
}

describe("OpenCode 2 entrypoints", () => {
  test("server default export satisfies both loaders", async () => {
    const mod = await import("../dist/server.js")
    expect(mod.default.id).toBe("@honcho-ai/opencode-honcho")
    expect(typeof mod.default.setup).toBe("function") // v2 reads id + setup
    expect(typeof mod.default.server).toBe("function") // v1 calls server()
    expect(mod.server).toBe(mod.default.server)
  })

  test("tui default export satisfies both loaders", async () => {
    const mod = await import("../dist/tui.js")
    expect(mod.default.id).toBe("@honcho-ai/opencode-honcho")
    expect(typeof mod.default.tui).toBe("function")
    expect(typeof mod.default.setup).toBe("function")
    expect(mod.__testing.buildCommandsV2({}).map((c) => c.slash.name)).toEqual([
      "honcho:setup",
      "honcho:status",
      "honcho:settings",
      "honcho:config",
      "honcho:import",
    ])
  })

  test("setup registers hooks, tools, and injects the system instruction", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-"))
    const configPath = path.join(home, "config.json")
    await writeFile(configPath, JSON.stringify({ peerName: "wire", baseUrl: "http://127.0.0.1:9", hosts: { opencode: { recallMode: "tools" } } }))

    const { ctx, hooks, tools, find } = fakeContext()
    ctx.options = { configPath }
    const mod = await import("../dist/server.js")
    const cleanup = await mod.default.setup(ctx)

    expect(hooks.session.map((h) => h.name).sort()).toEqual(["compaction", "context", "prompt"])
    expect(hooks.tool.map((h) => h.name)).toEqual(["execute.after"])
    expect(hooks.shell.map((h) => h.name)).toEqual(["create.before"])
    expect(tools.map((t) => t.name).sort()).toEqual([
      "honcho_chat",
      "honcho_create_conclusion",
      "honcho_get_config",
      "honcho_search",
      "honcho_set_config",
      "honcho_setup",
      "honcho_status",
    ])
    // zod 4 objects implement Standard Schema, which v2 accepts as a tool input schema.
    expect(typeof tools[0].input["~standard"]).toBe("object")

    const context = { sessionID: "ses_wire", agent: "build", model: { providerID: "anthropic", id: "claude" }, system: [], messages: [], options: {}, tools: {} }
    await find(hooks.session, "context")(context)
    expect(context.system).toHaveLength(1) // recallMode=tools: instruction only, no snapshot
    expect(context.system[0].text).toContain("## Honcho Memory")

    const shell = { command: "ls", cwd: home, timeout: 1, shell: "sh", env: {} }
    await find(hooks.shell, "create.before")(shell)
    expect(shell.env.HONCHO_URL).toBe("http://127.0.0.1:9")

    const status = JSON.parse(await tools.find((t) => t.name === "honcho_status").execute({}, { sessionID: "ses_wire" }).then((r) => r.content))
    expect(status.telemetry.hostVersion).toBe("2.0.16")
    expect(status.configured).toBe(true)

    expect(typeof cleanup).toBe("function")
    await cleanup()
  })

  test("on OpenCode 2.2+ the memory goes in one session instruction entry, not the system prompt", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-"))
    const configPath = path.join(home, "config.json")
    await writeFile(configPath, JSON.stringify({ peerName: "wire", baseUrl: "http://127.0.0.1:9", hosts: { opencode: { recallMode: "tools" } } }))

    const { ctx, hooks, find } = fakeContext()
    ctx.options = { configPath }
    const stored = new Map()
    const puts = []
    ctx.session.instructions = {
      entry: {
        list: async ({ sessionID }) => [...stored].filter(([id]) => id.startsWith(`${sessionID}/`)).map(([id, value]) => ({ key: id.split("/")[1], value })),
        put: async ({ sessionID, key, value }) => {
          puts.push({ sessionID, key })
          stored.set(`${sessionID}/${key}`, value)
        },
        remove: async () => {},
      },
    }
    const mod = await import("../dist/server.js")
    const cleanup = await mod.default.setup(ctx)

    // Empty prompts: Honcho skips capturing them, so the test makes no network calls.
    const prompt = () => ({ sessionID: "ses_entry", messageID: "msg_1", prompt: { text: "" }, delivery: "steer" })
    await find(hooks.session, "prompt")(prompt())
    expect(puts).toEqual([{ sessionID: "ses_entry", key: "honcho.memory" }])
    expect(stored.get("ses_entry/honcho.memory")).toContain("## Honcho Memory")

    const context = { sessionID: "ses_entry", agent: "build", model: { providerID: "anthropic", id: "claude" }, system: [], messages: [], options: {}, tools: {} }
    await find(hooks.session, "context")(context)
    await find(hooks.session, "prompt")(prompt())
    expect(context.system).toEqual([])
    expect(puts).toHaveLength(1)

    // A reloaded plugin finds the stored entry and leaves it as it is.
    await cleanup()
    const reloaded = fakeContext()
    reloaded.ctx.options = { configPath }
    reloaded.ctx.session.instructions = ctx.session.instructions
    const cleanupReloaded = await mod.default.setup(reloaded.ctx)
    await reloaded.find(reloaded.hooks.session, "context")({ ...context, system: [] })
    expect(puts).toHaveLength(1)
    await cleanupReloaded()
  })
})

describe("OpenCode 2 cleanup", () => {
  test("cleanup waits for an in-flight Honcho write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-"))
    const configPath = path.join(dir, "config.json")
    await writeFile(configPath, JSON.stringify({ apiKey: "test-key", peerName: "wire" }))

    // Every Honcho request waits on the gate, then fails; the plugin logs and moves on.
    let release
    const gate = new Promise((resolve) => (release = resolve))
    let requests = 0
    const realFetch = globalThis.fetch
    const realError = console.error
    globalThis.fetch = async () => {
      requests += 1
      await gate
      throw new Error("stubbed")
    }
    console.error = () => {}
    try {
      const { ctx, emit } = fakeContext()
      ctx.options = { configPath }
      const cleanup = await (await import("../dist/server.js")).default.setup(ctx)
      await emit("session.step.ended", { sessionID: "ses_a", assistantMessageID: "msg_a" }, ctx.location.directory)
      while (requests === 0) await new Promise((resolve) => setTimeout(resolve, 5))

      let settled = false
      const closing = cleanup().then(() => (settled = true))
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(settled).toBe(false)
      release()
      await closing
    } finally {
      release()
      globalThis.fetch = realFetch
      console.error = realError
    }
  })
})

describe("OpenCode 2 event scoping", () => {
  test("an instance only acts on events from its own location", async () => {
    const keys = ["HONCHO_API_KEY", "HONCHO_URL", "HONCHO_BASE_URL", "OPENCODE_CONFIG_DIR", "OPENCODE_HONCHO_TRACE_EVENTS"]
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    const root = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-scope-"))
    const configPath = path.join(root, "config.json")
    await writeFile(configPath, JSON.stringify({ peerName: "wire" }))
    for (const key of keys) delete process.env[key]
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "opencode")
    process.env.OPENCODE_HONCHO_TRACE_EVENTS = "1"
    const savedError = console.error
    const lines = []
    console.error = (...args) => lines.push(args.map(String).join(" "))
    const waiting = []
    const stream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => waiting.push(resolve)) }) }
    const a = fakeContext({ directory: "/work/a", subscribe: () => stream })
    const b = fakeContext({ directory: "/work/b", subscribe: () => stream })
    a.ctx.options = { configPath }
    b.ctx.options = { configPath }
    const mod = await import("../dist/server.js")
    const cleanups = []
    const emit = async (type, sessionID, location) => {
      while (waiting.length < 2) await new Promise((resolve) => setTimeout(resolve, 5))
      const event = { id: type, created: Date.now(), type, ...(location ? { location: { directory: location } } : {}), data: { sessionID } }
      for (const resolve of waiting.splice(0)) resolve({ value: event, done: false })
      while (waiting.length < 2) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const ownedBy = () =>
      lines
        .map((line) => /event (\{.*\})$/.exec(line))
        .filter(Boolean)
        .map((match) => JSON.parse(match[1]))
        .filter((e) => e.owned)
        .map((e) => `${e.directory}:${e.type}:${e.sessionId}`)
    try {
      cleanups.push(await mod.default.setup(a.ctx))
      cleanups.push(await mod.default.setup(b.ctx))
      await emit("session.created", "ses_a", "/work/a")
      await emit("session.execution.succeeded", "ses_a") // carries no location: follows the session
      await emit("session.created", "ses_b", "/work/b")
      await emit("session.execution.succeeded", "ses_unknown")
      expect(ownedBy()).toEqual([
        "/work/a:session.created:ses_a",
        "/work/a:session.execution.succeeded:ses_a",
        "/work/b:session.created:ses_b",
      ])
    } finally {
      for (const cleanup of cleanups) cleanup()
      console.error = savedError
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })
})

describe("OpenCode 2 recall placement", () => {
  // Honcho API stub: creates echo their id, and the session context carries a recall per search query.
  const honchoFetch = async (url, init = {}) => {
    const target = new URL(url)
    if (/\/sessions\/[^/]+\/context$/.test(target.pathname))
      return Response.json({ messages: [], summary: null, peer_representation: `Recall for ${target.searchParams.get("search_query")}`, peer_card: null })
    if (target.pathname.endsWith("/messages")) return Response.json([])
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {}
    return Response.json({ id: body.id, metadata: {}, configuration: {}, created_at: new Date(0).toISOString() })
  }
  const withHoncho = async (run, { recallMode = "hybrid" } = {}) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-"))
    const configPath = path.join(home, "config.json")
    await writeFile(configPath, JSON.stringify({ apiKey: "test-key", peerName: "wire", hosts: { opencode: { recallMode } } }))
    const realFetch = globalThis.fetch
    globalThis.fetch = honchoFetch
    try {
      const mod = await import("../dist/server.js")
      // Each load is a fresh plugin instance, as after an OpenCode reload or restart.
      const load = async (stored, { version = "2.0.16" } = {}) => {
        const { ctx, hooks, find } = fakeContext({ directory: home })
        ctx.options = { configPath }
        ctx.app.version = version
        ctx.session.context = async ({ sessionID }) => (sessionID === "ses_place" ? stored() : [])
        const cleanup = await mod.default.setup(ctx)
        return { cleanup, prompt: find(hooks.session, "prompt"), context: find(hooks.session, "context") }
      }
      await run({ load, recallKey: "honchoRecall" }) // stored with each message, so the key must not change
    } finally {
      globalThis.fetch = realFetch
    }
  }

  test("prompt hook saves the recall in the prompt's metadata", async () => {
    await withHoncho(async ({ load, recallKey }) => {
      const plugin = await load(() => [])
      const event = { sessionID: "ses_place", messageID: "msg_1", prompt: { text: "fix memory injection" }, metadata: { client: "kept" }, delivery: "steer" }
      await plugin.prompt(event)
      expect(event.metadata).toEqual({ client: "kept", [recallKey]: expect.stringContaining("Recall for") })
      expect(event.prompt.text).toBe("fix memory injection")
      // An unchanged recall is still saved: if a revert or compaction removes the earlier prompt,
      // this one has to carry it. The context hook drops the repeat while both are shown.
      const again = { sessionID: "ses_place", messageID: "msg_2", prompt: { text: "fix memory injection" }, delivery: "steer" }
      await plugin.prompt(again)
      expect(again.metadata).toEqual({ [recallKey]: event.metadata[recallKey] })
      await plugin.cleanup()
    })
  })

  test("context hook puts each stored recall after its prompt, from any plugin instance", async () => {
    await withHoncho(async ({ load, recallKey }) => {
      const stored = (...messages) => messages.map(([id, type, recall]) => ({ id, type, ...(recall ? { metadata: { [recallKey]: recall } } : {}) }))
      const message = (id, role) => ({ id, role, content: [{ type: "text", text: id }] })
      const request = async (plugin, ...messages) => {
        const event = { sessionID: "ses_place", model: { providerID: "anthropic", id: "claude" }, system: [], messages }
        await plugin.context(event)
        return event.messages.map((m) => m.id ?? m.content[0].text)
      }

      let history = stored(["msg_1", "user", "R1"], ["msg_a", "assistant"], ["msg_2", "user", "R2"], ["msg_3", "user", "R2"], ["msg_4", "user"])
      const messages = [message("msg_1", "user"), message("msg_a", "assistant"), message("msg_2", "user"), message("msg_3", "user"), message("msg_4", "user")]
      const expected = ["msg_1", "R1", "msg_a", "msg_2", "R2", "msg_3", "msg_4"] // msg_3's repeat of R2 is skipped
      const first = await load(() => history)
      expect(await request(first, ...messages)).toEqual(expected)
      await first.cleanup()

      // A reload or restart keeps nothing in memory, and the request comes out the same.
      const second = await load(() => history)
      expect(await request(second, ...messages)).toEqual(expected)

      // Compaction or a revert removed msg_1 and msg_2: msg_3 now shows R2 itself.
      history = stored(["msg_3", "user", "R2"], ["msg_4", "user"])
      expect(await request(second, message("msg_3", "user"), message("msg_4", "user"))).toEqual(["msg_3", "R2", "msg_4"])
      await second.cleanup()
    })
  })

  // On OpenCode 2.3+ each request message carries its stored metadata.
  const metadataMessage = (id, role, recall) => ({ id, role, content: [{ type: "text", text: id }], ...(recall ? { metadata: { honchoRecall: recall } } : {}) })
  const requestOn = async (plugin, messages) => {
    const event = { sessionID: "ses_place", model: { providerID: "anthropic", id: "claude" }, system: [], messages }
    await plugin.context(event)
    return event.messages.map((m) => m.id ?? m.content[0].text)
  }

  test("on OpenCode 2.3+ the recall comes from the request's own messages, not the stored session", async () => {
    await withHoncho(async ({ load }) => {
      // The stored session's latest view leaves out msg_0, as after a native compaction; a model
      // switch can still bring msg_0 back into the request, and its recall has to come with it.
      const plugin = await load(() => {
        throw new Error("session.context is not needed on 2.3+")
      }, { version: "2.3.0" })
      const messages = [metadataMessage("msg_0", "user", "R0"), metadataMessage("msg_a", "assistant"), metadataMessage("msg_1", "user", "R1")]
      expect(await requestOn(plugin, messages)).toEqual(["msg_0", "R0", "msg_a", "msg_1", "R1"])
      await plugin.cleanup()
    })
  })

  test("recalls already shown stay after recallMode changes to tools", async () => {
    await withHoncho(
      async ({ load }) => {
        const plugin = await load(() => [], { version: "2.3.0" })
        expect(await requestOn(plugin, [metadataMessage("msg_1", "user", "R1"), metadataMessage("msg_2", "user")])).toEqual(["msg_1", "R1", "msg_2"])
        await plugin.cleanup()
      },
      { recallMode: "tools" },
    )
  })
})

describe("OpenCode 2 memory entry", () => {
  const entryStore = () => {
    const stored = new Map()
    const puts = []
    return {
      stored,
      puts,
      api: {
        entry: {
          list: async ({ sessionID }) => [...stored].filter(([id]) => id.startsWith(`${sessionID}/`)).map(([id, value]) => ({ key: id.split("/")[1], value })),
          put: async ({ sessionID, key, value }) => {
            puts.push({ sessionID, key })
            stored.set(`${sessionID}/${key}`, value)
          },
          remove: async ({ sessionID, key }) => {
            stored.delete(`${sessionID}/${key}`)
          },
        },
      },
    }
  }
  const setupWith = async (config, instructions) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "honcho-v2-"))
    const configPath = path.join(home, "config.json")
    await writeFile(configPath, JSON.stringify(config))
    const { ctx, hooks, find } = fakeContext({ directory: home })
    ctx.options = { configPath }
    ctx.app.version = "2.3.0"
    ctx.session.instructions = instructions
    const mod = await import("../dist/server.js")
    const cleanup = await mod.default.setup(ctx)
    return { cleanup, prompt: find(hooks.session, "prompt"), context: find(hooks.session, "context") }
  }
  const toolsConfig = { peerName: "wire", baseUrl: "http://127.0.0.1:9", hosts: { opencode: { recallMode: "tools" } } }
  // Empty prompts: Honcho skips capturing them, so these tests make no network calls.
  const prompt = (sessionID) => ({ sessionID, messageID: "msg_1", prompt: { text: "" }, delivery: "steer" })
  const context = (sessionID) => ({ sessionID, agent: "build", model: { providerID: "anthropic", id: "claude" }, system: [], messages: [], options: {}, tools: {} })

  test("a run that starts without a prompt gets the entry from the context hook", async () => {
    const entries = entryStore()
    const plugin = await setupWith(toolsConfig, entries.api)
    const event = context("ses_resumed")
    await plugin.context(event)
    // OpenCode read the instructions before this hook, so the entry reaches the model next step.
    expect(event.system).toEqual([])
    expect(entries.puts).toEqual([{ sessionID: "ses_resumed", key: "honcho.memory" }])
    await plugin.context(context("ses_resumed"))
    expect(entries.puts).toHaveLength(1)
    await plugin.cleanup()
  })

  test("an entry removed from outside comes back at the next prompt, not mid-turn", async () => {
    const entries = entryStore()
    const plugin = await setupWith(toolsConfig, entries.api)
    await plugin.prompt(prompt("ses_removed"))
    await entries.api.entry.remove({ sessionID: "ses_removed", key: "honcho.memory" })
    await plugin.context(context("ses_removed"))
    expect(entries.puts).toHaveLength(1)
    await plugin.prompt(prompt("ses_removed"))
    expect(entries.puts).toHaveLength(2)
    expect(entries.stored.get("ses_removed/honcho.memory")).toContain("## Honcho Memory")
    await plugin.cleanup()
  })

  test("a snapshot too large for an instruction entry is cut short, keeping the instruction", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      const target = new URL(url)
      if (/\/peers\/[^/]+\/context$/.test(target.pathname))
        return Response.json({ peer_id: "wire", target_id: "wire", representation: "fact ".repeat(80_000), peer_card: null })
      if (/\/sessions\/[^/]+\/context$/.test(target.pathname)) return Response.json({ messages: [], summary: null, peer_representation: null, peer_card: null })
      if (target.pathname.endsWith("/messages")) return Response.json([])
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {}
      return Response.json({ id: body.id, metadata: {}, configuration: {}, created_at: new Date(0).toISOString() })
    }
    try {
      const entries = entryStore()
      const plugin = await setupWith({ apiKey: "test-key", peerName: "wire", hosts: { opencode: { recallMode: "hybrid" } } }, entries.api)
      await plugin.prompt(prompt("ses_large"))
      const value = entries.stored.get("ses_large/honcho.memory")
      expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(256 * 1024)
      expect(value).toStartWith("## Honcho Memory")
      expect(value).toContain("fact fact")
      expect(value).toEndWith("[Honcho memory snapshot cut short to fit OpenCode's size limit.]")
      await plugin.cleanup()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
