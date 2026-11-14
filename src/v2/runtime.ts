import { z } from "zod"
import { createHonchoCore, ensureHonchoSkillInstalled, type HostAdapter, type HostLogLevel } from "../index.js"
import { isRecord, timestampToIso } from "../core.js"
import type { Model, Plugin } from "@opencode/plugin"

type ModelRef = Model.Ref
type PluginContext = Plugin.Context
type PluginDefinition = Plugin.Plugin
/** One event from `ctx.event.subscribe()`. */
type V2Event = ReturnType<PluginContext["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never

export const PLUGIN_ID = "@honcho-ai/opencode-honcho"

const SETTLE_TIMEOUT_MS = 15_000

const modelId = (model: ModelRef | undefined) => {
  if (!model || typeof model.id !== "string" || !model.id.trim()) return null
  const provider = typeof model.providerID === "string" ? model.providerID.trim() : ""
  return provider ? `${provider}/${model.id.trim()}` : model.id.trim()
}

const eventData = (event: V2Event): Record<string, unknown> => {
  const data: unknown = event.data
  return isRecord(data) ? data : {}
}
const str = (value: unknown) => (typeof value === "string" && value ? value : null)

const eventLocationDirectory = (event: V2Event) => {
  const location: unknown = isRecord(event) ? event.location : undefined
  return isRecord(location) ? str(location.directory) : null
}

/**
 * Logger for the v2 path. Always stderr: the OpenCode 2 server can run with stdout as its RPC
 * transport (`serve --stdio`), so a plugin must never write to stdout.
 */
const consoleHost = (directory: string, worktree: string | undefined): HostAdapter => ({
  directory,
  worktree,
  log: async (level: HostLogLevel, message: string, extra: Record<string, unknown> = {}) => {
    console.error(`[opencode-honcho] ${level}: ${message} ${JSON.stringify(extra)}`)
  },
})

// One live runtime per plugin location. OpenCode 2 instantiates the plugin once per location and
// hot-reloads it by running the old generation's cleanup and then the new setup; a stale event
// loop must not keep capturing after that, while other locations keep running untouched.
const OWNER = Symbol.for("@honcho-ai/opencode-honcho.v2.generation")
const generations = (): Map<string, number> => {
  const g = globalThis as Record<symbol, Map<string, number> | undefined>
  return (g[OWNER] ??= new Map())
}
const nextGeneration = (location: string) => {
  const next = (generations().get(location) ?? 0) + 1
  generations().set(location, next)
  return next
}
const isCurrentGeneration = (location: string, generation: number) => generations().get(location) === generation

// Where the prompt hook saves a prompt's recall: the metadata OpenCode stores with the message.
const RECALL_METADATA_KEY = "honchoRecall"
const recallIn = (metadata: Record<string, unknown> | undefined) => {
  const recall = metadata?.[RECALL_METADATA_KEY]
  return typeof recall === "string" && recall ? recall : undefined
}
// OpenCode 2.3 gives the context hook each message's stored metadata (OpenCode #63590). A version
// that is not a release number is taken to be a current build.
const passesMessageMetadata = (version: string) => {
  const [major, minor] = version.split(".").map(Number)
  return !(major === 2 && minor < 3)
}

export const setup = async (ctx: PluginContext) => {
  const location = ctx.location.directory
  const generation = nextGeneration(location)
  const configPath =
    typeof ctx.options?.configPath === "string" ? ctx.options.configPath : process.env.OPENCODE_HONCHO_CONFIG_PATH || undefined
  const core = createHonchoCore(consoleHost(ctx.location.directory, ctx.location.project?.directory), configPath)
  core.setHostVersion(ctx.app.version)

  const here = ctx.location.directory
  const sessionDirectories = new Map<string, string>()
  const ownsSession = (event: V2Event, sessionID: string) => {
    const published = eventLocationDirectory(event)
    if (published) sessionDirectories.set(sessionID, published)
    return (published ?? sessionDirectories.get(sessionID)) === here
  }

  const messageMetadata = passesMessageMetadata(ctx.app.version)
  // Before OpenCode 2.3 the context hook gets no message metadata, so the recalls are read from the
  // stored session. That is the latest compaction's view, which can miss prompts that a model switch
  // brings back after a native compaction.
  const storedRecalls = async (sessionID: string) => {
    const recalls = new Map<string, string>()
    for (const message of await ctx.session.context({ sessionID })) {
      const recall = message.type === "user" ? recallIn(message.metadata) : undefined
      if (recall) recalls.set(message.id, recall)
    }
    return recalls
  }

  await ctx.session.hook("prompt", async (event) => {
    sessionDirectories.set(event.sessionID, here)
    const text = typeof event.prompt.text === "string" ? event.prompt.text.trim() : ""
    if (!text) return
    const block = await core.captureUserPrompt(
      { sessionID: event.sessionID },
      text,
      timestampToIso(Date.now()),
      "session.prompt",
      { skipUnchanged: false },
    )
    // Prompt-specific recall. The v1 path appends it to the user message; on v2 the prompt hook's
    // edits to the text become what the user wrote, so the recall is saved in the prompt's metadata
    // instead, and the context hook puts it back on every step.
    if (block) event.metadata = { ...event.metadata, [RECALL_METADATA_KEY]: block }
    await core.log("debug", "Honcho captured user prompt.", { sessionId: event.sessionID, recall: Boolean(block) })
  })

  await ctx.session.hook("context", async (event) => {
    core.rememberSessionModel(event.sessionID, modelId(event.model))
    for (const text of await core.systemBlocks({ sessionID: event.sessionID })) event.system.push({ type: "text", text })
    // Each recall goes right after the prompt it was retrieved for, read from that prompt's stored
    // metadata. Being stored, it survives plugin reloads and server restarts, moves with a queued
    // prompt, and goes away when a revert or compaction removes its prompt, so earlier history never
    // changes between steps. Stored recalls are always shown: recallMode only decides whether new ones
    // are fetched. A recall identical to the last one still shown is skipped.
    const stored = messageMetadata ? undefined : await storedRecalls(event.sessionID)
    let shown: string | undefined
    for (let at = 0; at < event.messages.length; at++) {
      const message = event.messages[at]
      if (message?.role !== "user") continue
      const recall = stored ? (message.id ? stored.get(message.id) : undefined) : recallIn(message.metadata)
      if (!recall || recall === shown) continue
      shown = recall
      event.messages.splice(++at, 0, { role: "user", content: [{ type: "text", text: recall }] })
    }
  })

  await ctx.session.hook("compaction", async (event) => {
    event.system.push({ type: "text", text: await core.continuityBlock({ sessionID: event.sessionID }) })
  })

  await ctx.shell.hook("create.before", async (event) => {
    Object.assign(event.env, await core.shellEnv({}))
  })

  await ctx.tool.hook("execute.after", async (event) => {
    await core.captureToolActivity(event.sessionID, event.tool, event.input, event.id, "tool.execute.after")
  })

  await ctx.tool.transform((editor) => {
    for (const spec of core.toolSpecs) {
      editor.add({
        name: spec.name,
        description: spec.description,
        input: z.object(spec.args),
        options: { codemode: false },
        execute: async (input, context) => ({
          content: await spec.execute(isRecord(input) ? input : {}, context.sessionID),
        }),
      })
    }
  })

  const handleEvent = async (event: V2Event) => {
    const data = eventData(event)
    const sessionID = str(data.sessionID)
    if (!sessionID) return
    const owned = ownsSession(event, sessionID)
    if (event.type === "session.deleted") sessionDirectories.delete(sessionID)
    if (process.env.OPENCODE_HONCHO_TRACE_EVENTS) {
      await core.log("debug", "event", {
        type: event.type,
        sessionId: sessionID,
        location: eventLocationDirectory(event),
        directory: ctx.location.directory,
        owned,
      })
    }
    if (!owned) return
    switch (event.type) {
      case "session.created": {
        // Best effort, never blocks startup, attempted even when Honcho is not configured.
        void ensureHonchoSkillInstalled()
        await core.hydrateSession({ sessionID })
        return
      }
      case "session.step.started": {
        const model = isRecord(data.model) ? (data.model as ModelRef) : undefined
        core.rememberSessionModel(sessionID, modelId(model))
        return
      }
      case "session.text.ended": {
        const messageId = str(data.assistantMessageID)
        const text = typeof data.text === "string" ? data.text : ""
        if (messageId) await core.stashAssistantText(sessionID, messageId, String(data.ordinal ?? 0), text)
        return
      }
      case "session.step.ended": {
        const messageId = str(data.assistantMessageID)
        if (messageId) {
          const captured = await core.flushAssistantMessage(sessionID, messageId, timestampToIso(event.created), "event.session.step.ended")
          if (captured) await core.log("debug", "Honcho captured assistant message.", { sessionId: sessionID, messageId })
        }
        return
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.execution.failed": {
        // Turn boundary: flush anything a step did not close. On a stop, whatever the user saw
        // before it is what gets remembered.
        for (const messageId of await core.pendingAssistantMessageIds(sessionID)) {
          const captured = await core.flushAssistantMessage(sessionID, messageId, timestampToIso(event.created), `event.${event.type}`)
          if (captured) await core.log("debug", "Honcho captured assistant message.", { sessionId: sessionID, messageId, event: event.type })
        }
        return
      }
      case "session.deleted": {
        await core.dropSessionState({ sessionID })
        return
      }
      case "session.compaction.ended": {
        const handle = await core.deriveHandle({ sessionID })
        await core.log("info", "Honcho lifecycle boundary observed.", {
          event: event.type,
          sessionId: handle.sessionId,
          sessionKey: handle.sessionKey,
        })
        return
      }
      default:
        return
    }
  }

  const controller = new AbortController()
  const inflight = new Set<Promise<void>>()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (!isCurrentGeneration(location, generation)) break
        const work = handleEvent(event)
        inflight.add(work)
        try {
          await work
        } catch (error) {
          await core.log("error", "Honcho event handling failed.", {
            event: event.type,
            message: error instanceof Error ? error.message : String(error),
          })
        } finally {
          inflight.delete(work)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        await core.log("error", "Honcho event subscription ended.", {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })()

  await core.log("info", "Honcho plugin loaded for OpenCode v2.", {
    version: ctx.app.version,
    channel: ctx.app.channel,
    directory: ctx.location.directory,
  })

  // `opencode run --standalone` exits once this resolves, so wait for writes still in flight.
  // Never await the stream itself: that stalls plugin reloads.
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETTLE_TIMEOUT_MS)
    })
    await Promise.race([Promise.allSettled([...inflight]), timeout]).finally(() => clearTimeout(timer))
    controller.abort()
  }
}

export const definition: PluginDefinition = { id: PLUGIN_ID, setup }
