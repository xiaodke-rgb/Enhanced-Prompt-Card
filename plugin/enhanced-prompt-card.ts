// Enhanced Prompt Card — two reminders appended to the current user message of a
// top-level turn, in the request copy only.
//
// first ("每轮首次注入") lands on the first model call of a user turn.
// step  ("每步注入")     lands on every model call of that turn, first included.
//
// The plugin only intercepts and assembles. It adds no text of its own: an empty
// part means no content, and when no part applies `event.messages` is untouched.
//
// Nothing is persisted: the overlay is appended to a cloned copy of the user
// message in `event.messages`, never to the stored prompt, never as a second user
// message, and never after assistant/tool output.
//
// Failure policy: fail open. Any unexpected error means "no injection".

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const CONFIG_PATH = join(homedir(), ".config/opencode/enhanced-prompt-card.json")
const DEFAULT_LOG_PATH = join(homedir(), ".config/opencode/enhanced-prompt-card-events.jsonl")

const SESSION_TTL_MS = 60_000
const TURN_TTL_MS = 10 * 60_000

const DEFAULT_AGENTS = ["plan", "build"]

const DEFAULT_FIRST =
  "[系统提醒(非用户问题)] 先判意图：ANSWER 直接答；SEARCH/READ 确需才查；DO 明确要求才做，问句不算；不明确按上下文补全，仍不唯一就问，不动手。"

const DEFAULT_STEP =
  "[纪律提醒(非用户问题)] 先结论，默认简洁回答，不复述，不铺垫；用户要求详细时除外。"

const LEGACY_MARKERS = ["[本轮提醒]", "[本轮意图]"]

type Part = {
  enabled: boolean
  agents: string[]
  text: string
}

type Config = {
  enabled: boolean
  first: Part
  step: Part
  logging: { enabled: boolean; path: string }
}

type TurnState = {
  messageID: string
  firstPending: boolean
  ts: number
}

const turns = new Map<string, TurnState>()
const sessionCache = new Map<string, { main: boolean; agent: string; ts: number }>()

let configCache: Config = baseConfig()
let configMtime = -1

function baseConfig(): Config {
  return {
    enabled: true,
    first: { enabled: true, agents: [...DEFAULT_AGENTS], text: DEFAULT_FIRST },
    step: { enabled: true, agents: [...DEFAULT_AGENTS], text: DEFAULT_STEP },
    logging: { enabled: true, path: DEFAULT_LOG_PATH },
  }
}

function normalizeAgents(value: any): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const agent = String(item || "").trim().slice(0, 100)
    if (!agent || out.includes(agent)) continue
    out.push(agent)
    if (out.length >= 50) break
  }
  return out
}

function normalizePart(raw: any, fallback: Part): Part {
  const next: Part = {
    enabled: fallback.enabled,
    agents: [...fallback.agents],
    text: fallback.text,
  }
  if (!raw || typeof raw !== "object") return next
  if (typeof raw.enabled === "boolean") next.enabled = raw.enabled
  // Presence of the array is meaningful: [] means "no agent at all", which must
  // not silently fall back to the default scope.
  if (Array.isArray(raw.agents)) next.agents = normalizeAgents(raw.agents)
  if (typeof raw.text === "string") next.text = raw.text.trim()
  return next
}

function normalizeConfig(raw: any): Config {
  const next = baseConfig()
  if (!raw || typeof raw !== "object") return next
  if (typeof raw.enabled === "boolean") next.enabled = raw.enabled
  next.first = normalizePart(raw.first, next.first)
  next.step = normalizePart(raw.step, next.step)
  if (raw.logging && typeof raw.logging === "object") {
    if (typeof raw.logging.enabled === "boolean") next.logging.enabled = raw.logging.enabled
    if (typeof raw.logging.path === "string" && raw.logging.path.startsWith("~/")) {
      next.logging.path = raw.logging.path
    }
  }
  return next
}

function loadConfig(): Config {
  try {
    const stat = statSync(CONFIG_PATH)
    if (stat.mtimeMs !== configMtime) {
      configCache = normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")))
      configMtime = stat.mtimeMs
    }
    return configCache
  } catch {
    // Missing or unreadable file: use defaults, not the last broken config.
    configCache = baseConfig()
    configMtime = -1
    return configCache
  }
}

function expandPath(path: string): string {
  const value = String(path || "")
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
}

function logEvent(event: Record<string, unknown>): void {
  const cfg = loadConfig()
  if (!cfg.logging.enabled) return
  try {
    const path = expandPath(cfg.logging.path)
    if (!path) return
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(event) + "\n")
  } catch {
    // Diagnostics must never break a turn.
  }
}

function roleOf(message: any): string {
  return String(message?.role || message?.type || "")
}

function contentText(message: any): string {
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part && part.type === "text")
      .map((part: any) => String(part.text || ""))
      .join("\n")
  }
  return String(message?.text || "")
}

function isSynthetic(message: any): boolean {
  if (message?.synthetic === true) return true
  if (String(message?.type || "") === "synthetic") return true
  return contentText(message).trimStart().startsWith("<system-reminder>")
}

function isInjectedPart(part: any, snippets: string[]): boolean {
  const text = String(part?.text || "")
  if (!text) return false
  for (const marker of LEGACY_MARKERS) {
    if (text.includes(marker)) return true
  }
  const trimmed = text.trim()
  if (!trimmed) return false
  for (const snippet of snippets) {
    if (trimmed === snippet || trimmed.endsWith("\n" + snippet)) return true
  }
  if (snippets.length === 2 && trimmed === snippets[0] + "\n" + snippets[1]) return true
  return false
}

// Remove reminders left at the tail of a message by a previous run of this hook
// (retries and hot reloads can hand back an already overlaid copy). Nothing else
// is stripped.
function stripInjectedText(text: string, snippets: string[]): string {
  let out = String(text || "")
  for (const marker of LEGACY_MARKERS) {
    const index = out.indexOf("\n\n" + marker)
    if (index >= 0) out = out.slice(0, index)
  }
  const ordered = snippets.filter(Boolean).slice().sort((a, b) => b.length - a.length)
  for (let i = 0; i < 4; i++) {
    const trimmed = out.replace(/\s+$/, "")
    const hit = ordered.find((snippet) => trimmed.endsWith(snippet))
    if (!hit) break
    out = trimmed.slice(0, trimmed.length - hit.length).replace(/\s+$/, "")
  }
  return out
}

function withOverlay(message: any, overlay: string, snippets: string[]): any {
  const copy = { ...message }
  const content = message?.content

  if (Array.isArray(content)) {
    const parts = content.filter((part: any) => !isInjectedPart(part, snippets))
    const hasText = parts.some(
      (part: any) => part && part.type === "text" && String(part.text || "").trim(),
    )
    // Some projected messages carry text in `text` instead of a text part.
    if (!hasText && typeof message?.text === "string" && message.text.trim()) {
      parts.push({ type: "text", text: stripInjectedText(message.text, snippets) })
    }
    parts.push({ type: "text", text: overlay })
    copy.content = parts
    return copy
  }

  if (typeof content === "string") {
    copy.content = stripInjectedText(content, snippets) + "\n\n" + overlay
    return copy
  }

  if (typeof message?.text === "string") {
    copy.text = stripInjectedText(message.text, snippets) + "\n\n" + overlay
    return copy
  }

  copy.content = [{ type: "text", text: overlay }]
  return copy
}

function findCurrentUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (roleOf(messages[i]) === "user") return i
  }
  return -1
}

function partText(part: Part, agent: string): string {
  if (!part.enabled) return ""
  if (!agent || !part.agents.includes(agent)) return ""
  return part.text.trim()
}

async function resolveSession(
  ctx: any,
  sessionID: string,
  hintAgent: string,
): Promise<{ main: boolean; agent: string } | null> {
  const now = Date.now()
  const cached = sessionCache.get(sessionID)
  if (cached && now - cached.ts < SESSION_TTL_MS) {
    return { main: cached.main, agent: hintAgent || cached.agent }
  }
  let info: any = null
  try {
    info = await ctx.session.get({ sessionID })
  } catch {
    return null
  }
  if (!info) return null
  const agent = String(info.agent || hintAgent || "")
  const main = !info.parentID
  sessionCache.set(sessionID, { main, agent, ts: now })
  return { main, agent: hintAgent || agent }
}

async function onPrompt(ctx: any, event: any): Promise<void> {
  try {
    const cfg = loadConfig()
    if (!cfg.enabled) return

    const sessionID = String(
      event?.sessionID || event?.session?.id || event?.message?.sessionID || "",
    )
    const messageID = String(event?.messageID || event?.message?.id || "")
    if (!sessionID) return

    const session = await resolveSession(ctx, sessionID, "")
    if (!session || !session.main) return

    const agent = session.agent
    const hasFirst = !!partText(cfg.first, agent)
    const hasStep = !!partText(cfg.step, agent)
    if (!hasFirst && !hasStep) return

    // A new prompt starts a new turn; the first model call of that turn carries
    // the "first" reminder once.
    turns.set(sessionID, { messageID, firstPending: true, ts: Date.now() })
  } catch {
    // Never block the prompt.
  }
}

async function onContext(ctx: any, event: any): Promise<void> {
  try {
    const cfg = loadConfig()
    if (!cfg.enabled) return

    const sessionID = String(event?.sessionID || "")
    const messages = Array.isArray(event?.messages) ? event.messages : null
    if (!sessionID || !messages || messages.length === 0) return

    const session = await resolveSession(ctx, sessionID, String(event?.agent || ""))
    if (!session || !session.main) return
    const agent = session.agent

    const last = messages[messages.length - 1]
    // Plan mode appends a synthetic <system-reminder> as a user message after the
    // assistant reply. It is not a new user turn; never overlaid.
    if (isSynthetic(last)) return

    const userIndex = findCurrentUserIndex(messages)
    if (userIndex < 0) return

    const currentID = String(messages[userIndex]?.id || "")
    const state = turns.get(sessionID)
    let isFirst = false

    if (state) {
      if (state.firstPending && Date.now() - state.ts <= TURN_TTL_MS) {
        isFirst = true
      } else if (
        roleOf(last) === "user" &&
        state.messageID &&
        currentID &&
        state.messageID !== currentID
      ) {
        // The prompt hook was missed (plugin reloaded mid-turn, or another
        // client sent the prompt): a different user message means a new turn.
        isFirst = true
      }
    } else if (roleOf(last) === "user") {
      // No state at all and the call starts a turn: treat it as the first call.
      isFirst = true
    }

    const firstText = partText(cfg.first, agent)
    const stepText = partText(cfg.step, agent)
    const segments: string[] = []
    if (isFirst && firstText) segments.push(firstText)
    if (stepText) segments.push(stepText)

    // The plugin only assembles what the config gives it. Nothing to say means
    // no touch at all: no clone, no marker, no empty line.
    if (segments.length === 0) return

    const overlay = segments.join("\n")
    const snippets = [firstText, stepText].filter(Boolean)
    let error: string | null = null

    try {
      const next = messages.slice()
      next[userIndex] = withOverlay(messages[userIndex], overlay, snippets)
      event.messages = next

      // Consume the first flag only after the request copy was accepted, so a
      // retry after a failed injection can still carry it.
      if (isFirst) {
        turns.set(sessionID, {
          messageID: currentID || state?.messageID || "",
          firstPending: false,
          ts: Date.now(),
        })
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    if (isFirst) {
      logEvent({
        ts: new Date().toISOString(),
        sessionID,
        agent,
        injectedFirst: !!firstText && !error,
        injectedStep: !!stepText && !error,
        error,
      })
    }
  } catch {
    // Fail open.
  }
}

export default {
  id: "enhanced-prompt-card",
  async setup(ctx: any) {
    await ctx.session.hook("prompt", (event: any) => onPrompt(ctx, event))
    await ctx.session.hook("context", (event: any) => onContext(ctx, event))
  },
}
