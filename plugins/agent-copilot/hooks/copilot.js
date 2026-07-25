#!/usr/bin/env node
/**
 * copilot — a second-opinion "co-pilot" for the main Claude Code agent.
 *
 * Runs as a Claude Code command hook. Replays the conversation transcript
 * into a fresh API request, then runs a two-stage tool-call cascade: Stage 1
 * (non-thinking, forced tool_choice) classifies which checks need deeper
 * evaluation; Stage 2 (thinking, auto tool_choice) synthesizes the final
 * hook stdout JSON that Claude Code applies to the hook event.
 *
 * The design is "kubeadm-style": every semantically distinct step is a named
 * phase invokable independently from the CLI, so individual pieces can be
 * inspected and debugged without running the whole pipeline.
 *
 * ============================================================================
 * Architecture
 * ============================================================================
 *
 * CLI phase tree
 * --------------
 *   copilot.js [phase] [sub-phase] [args]
 *     (no phase + piped stdin → run the full pipeline as a hook entry)
 *
 *   replay <transcript>             Reconstruct what Claude Code would send.
 *     ├── messages <transcript> [entryUuid]
 *     │                             Reconstruct the messages array; optionally
 *     │                             stop at a transcript entry UUID.
 *     └── claudemd [<cwd>]          Render just the nested_memory
 *                                   <system-reminder> block (CLAUDE.md /
 *                                   AGENTS.md tree).
 *
 *   stage1 <hook-input.json>        Stage 1 forced tool_choice classification.
 *     ├── request <hook-input.json>   Build and print only the request body.
 *     └── response <hook-input.json>  Send and print only the API response.
 *
 *   stage2 <hook-input.json> [comma-flags]
 *                                   Stage 2 synthesis. If comma-flags is
 *                                   omitted, runs Stage 1 first to derive
 *                                   them; if provided, skips the Stage 1 API
 *                                   call but still builds the Stage 1 user
 *                                   message and a synthetic Stage 1 tool_use
 *                                   so the conversation continuation matches
 *                                   a real run.
 *     ├── request <hook-input.json> [comma-flags]
 *     │                             Build and print only the request body.
 *     └── response <hook-input.json> [comma-flags]
 *                                   Send and print only the API response.
 *
 *   pipeline <hook-input.json>      End-to-end Stage 1 + Stage 2. Equivalent
 *                                   to piping the hook input on stdin.
 *
 * Replay call graph
 * -----------------
 *   loadTranscript(path)              parse JSONL → { messages, hookSuccesses,
 *   │                                   rawEntries }
 *   ├── normalizeBlock(block)         keep only API-valid fields per type
 *   │                                 (drop Claude Code's internal `caller`, etc.)
 *   ├── injectAttachment(msgs, att)   dispatch a JSONL `attachment` entry into
 *   │   │                             the preceding user message
 *   │   └── renderAttachment(att)     per-type <system-reminder> text:
 *   │                                   skill_listing / date_change /
 *   │                                   auto_mode{,_exit} / todo_reminder /
 *   │                                   queued_command. Returns null for types
 *   │                                   Claude Code does not surface
 *   │                                   (command_permissions, edited_text_file,
 *   │                                   nested_memory — see below).
 *   ├── renderClaudeMdContext(cwd)    build the nested_memory block from disk
 *   │   │                             and inject at messages[0]; the JSONL
 *   │   │                             nested_memory entry is ignored because
 *   │   │                             it only stores the unresolved @-reference
 *   │   └── resolveClaudeMd(path,…)   recursively follow `@path` references
 *   │       └── resolveRef(ref, base) expand ~ and resolve relative paths
 *   └── (post-process)                prune orphaned tool_use blocks
 *                                     (interrupted before they could run; the
 *                                     API rejects requests with orphans)
 *
 * Pipeline call graph
 * -------------------
 *   runPipeline(hookInput, agentName)
 *   ├── loadTranscript(transcript_path)
 *   ├── loadEvents() / loadChecks(eventNames)
 *   ├── loadAgentSystemPrompt(agentName)
 *   │     → 2-block `system`: [Claude Code identity, <agent>.md body],
 *   │       both cache_control ephemeral
 *   ├── buildToolsArray(events, checks)
 *   │     → for each event: stage1_<event> tool (flags.items.enum = union of
 *   │       check.hookEvents) and stage2_<event> tool (input_schema =
 *   │       hookOutputSchema + composed top-level `copilot` fields from each
 *   │       check's getHookOutputExtraSchema)
 *   ├── runStage1(ctx, eventModule, checks, …)
 *   │     forced tool_choice + thinking disabled → stage1AssistantMessage
 *   │     (empty thinking block prepended if the response lacks one, so
 *   │     thinking-mode-strict backends accept Stage 2's continuation)
 *   └── runStage2(ctx, eventModule, flaggedChecks, stage1, …)
 *         auto tool_choice + thinking enabled → final hook stdout JSON
 *
 * Key data shapes
 * ---------------
 *   Message      = { role: 'user'|'assistant', content: ContentBlock[] }
 *   ContentBlock = { type: 'text'|'thinking'|'tool_use'|'tool_result', ... }
 *
 * Exports
 * -------
 *   loadTranscript(transcriptPath, untilEntryUuid?)
 *     -> { messages, hookSuccesses, rawEntries }
 *   renderClaudeMdContext(cwd) -> string | null
 *   loadEvents() -> Map<hookEventName, eventModule>
 *   loadChecks(eventNames?) -> CheckModule[]
 *   loadAgentSystemPrompt(agentName='copilot') -> SystemBlock[]
 *   buildToolsArray(events, checks) -> Tool[]
 *   runPipeline(hookInput, agentName='copilot') -> hookStdout | null
 *
 * ============================================================================
 */

import { readFileSync, openSync, readSync, closeSync, fstatSync, existsSync, realpathSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Content block normalization
// ---------------------------------------------------------------------------

/**
 * @typedef {{type: string, [k: string]: any}} ContentBlock
 * @typedef {{role: 'user'|'assistant', content: ContentBlock[]}} Message
 */

/**
 * Per-block-type field whitelist for the Anthropic Messages API.
 * Anything not in this list (e.g. Claude Code's internal `caller`) is dropped.
 */
const BLOCK_FIELDS = {
  text: ['type', 'text', 'cache_control'],
  thinking: ['type', 'thinking', 'signature'],
  tool_use: ['type', 'id', 'name', 'input', 'cache_control'],
  tool_result: ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'],
};

/**
 * Normalize a content block by keeping only API-relevant fields.
 * @param {ContentBlock} block
 * @returns {ContentBlock | null}
 */
function normalizeBlock(block) {
  if (!block || typeof block !== 'object' || !block.type) return null;
  const allowed = BLOCK_FIELDS[block.type];
  if (!allowed) return null;
  /** @type {ContentBlock} */
  const out = { type: block.type };
  for (const key of allowed) {
    if (key === 'type') continue;
    const v = block[key];
    if (v !== null && v !== undefined) out[key] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLAUDE.md resolution (nested_memory rendering)
// ---------------------------------------------------------------------------

/**
 * Resolve a `@path` reference relative to a base file's directory.
 * Supports `~` and `~/...` expansion.
 * @param {string} ref — the path after the @
 * @param {string} baseFile — absolute path of the file containing the reference
 * @returns {string}
 */
function resolveRef(ref, baseFile) {
  if (ref.startsWith('~/')) return resolve(homedir(), ref.slice(2));
  if (ref === '~') return homedir();
  if (isAbsolute(ref)) return ref;
  return resolve(dirname(baseFile), ref);
}

/**
 * Recursively read a CLAUDE.md/AGENTS.md file and any files it references via `@path`.
 * Each file appears at most once (cycles ignored).
 * @param {string} filePath
 * @param {string} description — text label like "project instructions, ..."
 * @param {Set<string>} visited
 * @returns {{path: string, description: string, content: string}[]}
 */
function resolveClaudeMd(filePath, description, visited = new Set()) {
  if (visited.has(filePath)) return [];
  visited.add(filePath);
  if (!existsSync(filePath)) return [];

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const result = [{ path: filePath, description, content }];

  // Find @-references: lines that start with `@` followed by a path
  for (const line of content.split('\n')) {
    const m = line.match(/^@(\S+)/);
    if (!m) continue;
    const refPath = resolveRef(m[1], filePath);
    result.push(...resolveClaudeMd(refPath, description, visited));
  }

  return result;
}

/**
 * Build the full <system-reminder> block for nested_memory (CLAUDE.md context).
 * @param {string} cwd — project working directory
 * @returns {string | null} the rendered text, or null if no CLAUDE.md found
 */
function projectMemoryPath(cwd) {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return resolve(homedir(), '.claude', 'projects', slug, 'memory', 'MEMORY.md');
}

function readProjectMemoryIndex(cwd) {
  const memoryPath = projectMemoryPath(cwd);
  if (!existsSync(memoryPath)) return null;
  try {
    const content = readFileSync(memoryPath, 'utf-8');
    if (!content.trim()) return null;
    return { path: memoryPath, content };
  } catch {
    return null;
  }
}

export function renderClaudeMdContext(cwd) {
  // AGENT_COPILOT_CLAUDE_USER_ROOT overrides ~/.claude (test fixtures pin a
  // stable tree so scenario output doesn't drift with the live files).
  const userRoot = process.env.AGENT_COPILOT_CLAUDE_USER_ROOT || resolve(homedir(), '.claude');
  const userCmPath = resolve(userRoot, 'CLAUDE.md');
  const userCm = existsSync(userCmPath) ? userCmPath : undefined;
  // A project keeps CLAUDE.md either at its root or under .claude/ — the first
  // that exists wins, they are not merged.
  const projectCm = [resolve(cwd, 'CLAUDE.md'), resolve(cwd, '.claude', 'CLAUDE.md')].find((p) => existsSync(p));

  const userFiles = userCm ? resolveClaudeMd(userCm, "user's private global instructions for all projects") : [];
  const projectFiles = projectCm ? resolveClaudeMd(projectCm, 'project instructions, checked into the codebase') : [];
  const memoryIndex = readProjectMemoryIndex(cwd);

  if (userFiles.length === 0 && projectFiles.length === 0 && !memoryIndex) return null;

  let body = '';
  for (const f of [...userFiles, ...projectFiles]) {
    body += `Contents of ${f.path} (${f.description}):\n\n${f.content}\n`;
  }
  if (memoryIndex) {
    body += `Contents of ${memoryIndex.path} (user's auto-memory, persists across conversations):\n\n${memoryIndex.content}`;
    if (!body.endsWith('\n')) body += '\n';
  }

  // Date in YYYY/MM/DD format as Claude Code uses
  const now = new Date();
  const today = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;

  return (
    '<system-reminder>\n' +
    "As you answer the user's questions, you can use the following context:\n" +
    '# claudeMd\n' +
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n' +
    body +
    `# currentDate\nToday's date is ${today}.\n\n` +
    '      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n' +
    '</system-reminder>\n\n'
  );
}

// ---------------------------------------------------------------------------
// Attachment rendering
// ---------------------------------------------------------------------------

/**
 * Render an attachment payload into a `<system-reminder>` text snippet.
 * Matches the formats Claude Code actually injects.
 * @param {{type: string, [k: string]: any}} att
 * @returns {string | null} rendered text, or null to skip
 */
function renderAttachment(att) {
  switch (att.type) {
    case 'skill_listing':
      return `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n${att.content}\n</system-reminder>\n`;

    case 'nested_memory':
      // Skip: rebuilt from disk and injected at idx 0 in loadTranscript().
      return null;

    case 'date_change':
      return `<system-reminder>\nThe date has changed. Today's date is now ${att.newDate}. DO NOT mention this to the user explicitly because they are already aware.\n</system-reminder>\n`;

    case 'auto_mode':
      if (att.reminderType === 'sparse') {
        return `<system-reminder>\nAuto mode still active (see full instructions earlier in conversation). Execute autonomously, minimize interruptions, prefer action over planning.\n</system-reminder>`;
      }
      return `<system-reminder>\n## Auto Mode Active\n\nAuto mode is active. The user chose continuous, autonomous execution. You should:\n\n1. **Execute immediately** — Start implementing right away. Make reasonable assumptions and proceed on low-risk work.\n2. **Minimize interruptions** — Prefer making reasonable assumptions over asking questions for routine decisions.\n3. **Prefer action over planning** — Do not enter plan mode unless the user explicitly asks. When in doubt, start coding.\n4. **Expect course corrections** — The user may provide suggestions or course corrections at any point; treat those as normal input.\n5. **Do not take overly destructive actions** — This is not a license to destroy. Anything that deletes data or modifies shared or production systems still needs explicit user confirmation. If you reach such a decision point, ask and wait, or course correct to a safer method instead.\n6. **Avoid data exfiltration** — Post even routine messages to chat platforms or work tickets only if the user has directed you to. You must not share secrets (e.g. credentials, internal documentation) unless the user has explicitly authorized both that specific secret and its destination.\n</system-reminder>\n`;

    case 'auto_mode_exit':
      return `<system-reminder>\n## Exited Auto Mode\n\nYou have exited auto mode. The user may now want to interact more directly. You should ask clarifying questions when the approach is ambiguous rather than making assumptions.\n</system-reminder>\n`;

    case 'todo_reminder': {
      const itemCount = att.itemCount ?? 0;
      if (itemCount === 0) {
        return `<system-reminder>\nThe TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n\n</system-reminder>`;
      }
      // itemCount > 0: would include the current todos list, exact format unknown
      return `<system-reminder>\nYour current todo list:\n${JSON.stringify(att.content)}\n</system-reminder>`;
    }

    case 'queued_command': {
      const prompt = att.prompt;
      const text = typeof prompt === 'string'
        ? prompt
        : Array.isArray(prompt)
          ? prompt.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
          : '';
      return `<system-reminder>\nThe user sent a new message while you were working:\n${text}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n</system-reminder>`;
    }

    case 'command_permissions':
    case 'edited_text_file':
      // Internal state tracking — Claude Code does NOT render these in API requests.
      return null;

    default:
      return null;
  }
}

/**
 * Inject an attachment into the last user message in the messages array.
 *   - tool_result-only user message → append reminder to last tool_result.content
 *   - text-containing user message → prepend reminder as a new text block
 * @param {Message[]} messages
 * @param {{type: string, [k: string]: any}} att
 */
function injectAttachment(messages, att) {
  const rendered = renderAttachment(att);
  if (!rendered) return;

  let userMsg = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userMsg = messages[i];
      break;
    }
  }
  if (!userMsg) {
    userMsg = { role: 'user', content: [] };
    messages.unshift(userMsg);
  }

  const hasToolResult = userMsg.content.some((b) => b.type === 'tool_result');
  const hasText = userMsg.content.some((b) => b.type === 'text');

  if (hasToolResult && !hasText) {
    // Append to the last tool_result.content, separated by a blank line
    const lastTr = [...userMsg.content].reverse().find((b) => b.type === 'tool_result');
    if (lastTr) {
      if (typeof lastTr.content === 'string') {
        lastTr.content = lastTr.content + '\n\n' + rendered;
      } else if (Array.isArray(lastTr.content)) {
        lastTr.content.push({ type: 'text', text: '\n\n' + rendered });
      } else {
        lastTr.content = String(lastTr.content ?? '') + '\n\n' + rendered;
      }
    }
  } else {
    // Insert after any tool_result blocks but before user text
    const firstTextIdx = userMsg.content.findIndex(b => b.type === 'text');
    if (firstTextIdx >= 0) {
      userMsg.content.splice(firstTextIdx, 0, { type: 'text', text: rendered });
    } else {
      userMsg.content.unshift({ type: 'text', text: rendered });
    }
  }
}

// ---------------------------------------------------------------------------
// Tail-first transcript read
// ---------------------------------------------------------------------------

const LF = 0x0A;
const TAIL_CHUNK_SIZE = 1 << 20;  // 1 MB per read

/**
 * Read transcript entries from the latest `compact_boundary` system entry
 * (inclusive) to end of file. If no boundary exists, returns all entries.
 *
 * Reads the file in reverse from the end in 1 MB chunks, parsing JSONL lines
 * backward until the latest `type: "system", subtype: "compact_boundary"`
 * entry is found. Pre-boundary content is never read.
 *
 * Chunks are held in an array (not concatenated) so the only byte-copying
 * cost is per extracted line, not the growing buffer.
 *
 * @param {string} transcriptPath
 * @returns {object[]} entries in time order (boundary first, EOF last)
 */
function readTranscriptEntriesFromBoundary(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  const fd = openSync(transcriptPath, 'r');
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return [];

    /** @type {{ offset: number, buffer: Buffer }[]} chunks sorted by offset ascending */
    const chunks = [];
    let firstOffset = size;

    const prependChunk = () => {
      if (firstOffset === 0) return false;
      const n = Math.min(TAIL_CHUNK_SIZE, firstOffset);
      firstOffset -= n;
      const buffer = Buffer.alloc(n);
      readSync(fd, buffer, 0, n, firstOffset);
      chunks.unshift({ offset: firstOffset, buffer });
      return true;
    };

    /** Find file offset of the LF byte immediately before `before`, or -1 if not in chunks. */
    const findPrevLF = (before) => {
      for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (c.offset >= before) continue;
        const lastIdx = Math.min(c.offset + c.buffer.length, before) - 1 - c.offset;
        for (let j = lastIdx; j >= 0; j--) {
          if (c.buffer[j] === LF) return c.offset + j;
        }
      }
      return -1;
    };

    /** Copy file-offset range [start, end) into a new Buffer, spanning chunks as needed. */
    const extract = (start, end) => {
      const out = Buffer.alloc(end - start);
      let outPos = 0;
      for (const c of chunks) {
        const cEnd = c.offset + c.buffer.length;
        if (cEnd <= start) continue;
        if (c.offset >= end) break;
        const from = Math.max(c.offset, start) - c.offset;
        const to = Math.min(cEnd, end) - c.offset;
        c.buffer.copy(out, outPos, from, to);
        outPos += to - from;
      }
      return out;
    };

    prependChunk();

    // scanEnd = file offset (exclusive) of the line currently being processed.
    // Start at EOF, then strip trailing newlines so scanEnd points just past
    // the last meaningful byte.
    let scanEnd = size;
    while (scanEnd > firstOffset) {
      const last = chunks[chunks.length - 1];
      if (last.buffer[scanEnd - 1 - last.offset] !== LF) break;
      scanEnd--;
    }

    const collected = [];
    while (scanEnd > 0) {
      const lf = findPrevLF(scanEnd);

      // Partial line at start of buffered region — read more from earlier in file
      if (lf < 0 && firstOffset > 0) {
        prependChunk();
        continue;
      }

      const lineStart = lf >= 0 ? lf + 1 : 0;
      try {
        const entry = JSON.parse(extract(lineStart, scanEnd).toString('utf-8'));
        collected.push(entry);
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') break;
      } catch {
        // ignore unparseable lines
      }

      if (lf < 0) break;  // reached first line of file
      scanEnd = lf;
    }

    collected.reverse();
    return collected;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Transcript replay
// ---------------------------------------------------------------------------

/**
 * Load a Claude Code transcript JSONL file and reconstruct the Anthropic
 * messages array Claude Code would send.
 *
 * Replay starts at the latest `type: "system", subtype: "compact_boundary"`
 * entry, because after `/compact` Claude Code sends only the post-compact
 * summary plus subsequent turns to the model — pre-compact entries remain
 * in JSONL but are not part of the next API request. Implementation
 * reverse-parses lines from the end of the file, which incidentally avoids
 * JSON-parsing the pre-boundary majority of large compacted transcripts.
 *
 * Optionally bounded above by `untilEntryUuid`: replay covers entries from
 * the latest compact boundary up to and including that UUID (plus its direct
 * child attachments).
 *
 * Performs:
 *   - filter non-content JSONL types (queue-operation, file-history-snapshot, …)
 *   - skip sidechain (subagent) entries — they aren't visible to the main thread
 *   - normalize content blocks (strip Claude Code's internal `caller` field, etc.)
 *   - merge consecutive same-role entries (JSONL fragments one assistant turn across multiple lines)
 *   - render `attachment` entries into `<system-reminder>` text blocks
 *   - inject CLAUDE.md context at idx 0 (Claude Code's implicit nested_memory injection)
 *   - prune orphaned tool_use blocks (interrupted calls without matching tool_result)
 *
 * @param {string} transcriptPath
 * @returns {{messages: Message[], hookSuccesses: any[], rawEntries: any[]}}
 */
export function loadTranscript(transcriptPath, untilEntryUuid = null) {
  const entries = readTranscriptEntriesFromBoundary(transcriptPath);

  // Apply untilEntryUuid upper bound: walk forward, stop after the target
  // entry (and include its direct child attachments, which immediately follow
  // it in JSONL).
  const keptEntries = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    keptEntries.push(e);
    if (untilEntryUuid && e.uuid === untilEntryUuid) {
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[j].parentUuid === untilEntryUuid) {
          keptEntries.push(entries[j]);
        } else {
          break;
        }
      }
      break;
    }
  }

  /** @type {Message[]} */
  const messages = [];
  const hookSuccesses = [];
  const hookAdditionalContexts = [];
  let cwd = process.cwd();

  for (const entry of keptEntries) {
    if (typeof entry.cwd === 'string') cwd = entry.cwd;
    if (entry.isSidechain === true) continue;

    if (entry.type === 'attachment' && entry.attachment) {
      if (entry.attachment.type === 'hook_success') {
        hookSuccesses.push(entry.attachment);
        continue;
      }
      if (entry.attachment.type === 'hook_additional_context') {
        hookAdditionalContexts.push(entry.attachment);
        continue;
      }
      if (entry.attachment.type === 'hook_system_message') continue;
      injectAttachment(messages, entry.attachment);
      continue;
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (!entry.message || typeof entry.message !== 'object') continue;

    // Content can be either an array of blocks OR a plain string.
    let rawContent = entry.message.content;
    if (typeof rawContent === 'string') {
      if (rawContent.length === 0) continue;
      rawContent = [{ type: 'text', text: rawContent }];
    }
    if (!Array.isArray(rawContent)) continue;
    if (rawContent.length === 0) continue;

    const role = entry.message.role;
    const content = rawContent
      .map(normalizeBlock)
      .filter((b) => b !== null);
    if (content.length === 0) continue;

    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(...content);
    } else {
      messages.push({ role, content });
    }
  }

  // Inject CLAUDE.md context (nested_memory) at idx 0, after skill_listing if present.
  // If transcript was empty (e.g. UserPromptSubmit at session start, before Claude
  // Code has flushed the first user message to disk), synthesize a first user
  // message so the CLAUDE.md context still rides along.
  const claudeMdText = renderClaudeMdContext(cwd);
  if (claudeMdText) {
    let firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) {
      firstUser = { role: 'user', content: [] };
      messages.unshift(firstUser);
    }
    let insertAt = 0;
    for (let i = 0; i < firstUser.content.length; i++) {
      const b = firstUser.content[i];
      if (b.type === 'text' && typeof b.text === 'string' &&
          b.text.includes('The following skills are available for use with the Skill tool')) {
        insertAt = i + 1;
        break;
      }
    }
    firstUser.content.splice(insertAt, 0, { type: 'text', text: claudeMdText });
  }

  // Prune orphaned tool_use blocks (interrupted before they could execute)
  const resultIds = new Set();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.tool_use_id) resultIds.add(b.tool_use_id);
    }
  }
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    m.content = m.content.filter((b) => b.type !== 'tool_use' || resultIds.has(b.id));
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].content.length === 0) messages.splice(i, 1);
  }

  return { messages, hookSuccesses, hookAdditionalContexts, rawEntries: keptEntries };
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

const COPILOT_DIR = dirname(fileURLToPath(import.meta.url));

async function loadModulesWithPaths(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => join(dir, e.name))
    .sort();
  const mods = await Promise.all(files.map(f => import(pathToFileURL(f).href)));
  return files.map((path, i) => ({ path, mod: mods[i] }));
}

const EVENT_REQUIRED = {
  hookEventName: 'string',
  hookInputSchema: 'object',
  hookOutputSchema: 'object',
  stage1ToolDescription: 'string',
  stage2ToolDescription: 'string',
  getStage1Prompt: 'function',
  getStage2Prompt: 'function',
};

const CHECK_REQUIRED = {
  name: 'string',
  hookEvents: 'object',
  getStage1Prompt: 'function',
  getStage2Prompt: 'function',
};

function validateExports(mod, path, required) {
  for (const [key, kind] of Object.entries(required)) {
    const v = mod[key];
    if (kind === 'object') {
      if (!v || typeof v !== 'object') {
        throw new Error(`${path}: missing or non-object named export '${key}'`);
      }
    } else if (typeof v !== kind) {
      throw new Error(`${path}: missing or wrong-type named export '${key}' (expected ${kind})`);
    }
  }
}

export async function loadEvents() {
  const entries = await loadModulesWithPaths(resolve(COPILOT_DIR, 'events'));
  const map = new Map();
  for (const { path, mod } of entries) {
    validateExports(mod, path, EVENT_REQUIRED);
    if (mod.isTranscriptReady !== undefined && typeof mod.isTranscriptReady !== 'function') {
      throw new Error(`${path}: isTranscriptReady must be a function when present`);
    }
    if (mod.postProcessHookOutput !== undefined && typeof mod.postProcessHookOutput !== 'function') {
      throw new Error(`${path}: postProcessHookOutput must be a function when present`);
    }
    if (mod.preprocessHookInput !== undefined && typeof mod.preprocessHookInput !== 'function') {
      throw new Error(`${path}: preprocessHookInput must be a function when present`);
    }
    if (map.has(mod.hookEventName)) {
      throw new Error(`${path}: duplicate hookEventName '${mod.hookEventName}'`);
    }
    map.set(mod.hookEventName, mod);
  }
  return map;
}

export async function loadChecks(eventNames) {
  const dir = resolve(COPILOT_DIR, 'checks');
  if (!existsSync(dir)) return [];
  const entries = await loadModulesWithPaths(dir);
  const seen = new Map();
  const checks = [];
  for (const { path, mod } of entries) {
    validateExports(mod, path, CHECK_REQUIRED);
    if (!Array.isArray(mod.hookEvents) || mod.hookEvents.length === 0) {
      throw new Error(`${path}: hookEvents must be a non-empty array of hook event names`);
    }
    for (const ev of mod.hookEvents) {
      if (typeof ev !== 'string') {
        throw new Error(`${path}: hookEvents entries must be strings (got ${typeof ev})`);
      }
      if (eventNames && !eventNames.has(ev)) {
        throw new Error(`${path}: hookEvents lists unknown event '${ev}' (known: ${[...eventNames].sort().join(', ')})`);
      }
    }
    if (mod.getHookOutputExtraSchema !== undefined && typeof mod.getHookOutputExtraSchema !== 'function') {
      throw new Error(`${path}: getHookOutputExtraSchema must be a function when present`);
    }
    if (seen.has(mod.name)) {
      throw new Error(`${path}: duplicate check name '${mod.name}' (also in ${seen.get(mod.name)})`);
    }
    seen.set(mod.name, path);
    checks.push(mod);
  }
  return checks;
}

export function loadAgentSystemPrompt(agentName = 'copilot') {
  const path = resolve(COPILOT_DIR, `${agentName}.md`);
  const raw = readFileSync(path, 'utf8');
  const stripped = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  return [
    {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: stripped.trim(),
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// ---------------------------------------------------------------------------
// Static tools array
// ---------------------------------------------------------------------------

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function discoverCandidateNames(checks, hookEvent) {
  const names = [];
  for (const check of checks) {
    if (check.hookEvents.includes(hookEvent)) names.push(check.name);
  }
  names.sort();
  return names;
}

function composeStage2Schema(hookOutputSchema, checks, hookEvent) {
  const schema = deepClone(hookOutputSchema);
  if (!schema.properties || typeof schema.properties !== 'object') {
    throw new Error(`event '${hookEvent}' hookOutputSchema must have properties`);
  }

  const copilotProps = {};
  const ownerOf = new Map();
  for (const check of checks) {
    const extra = check.getHookOutputExtraSchema?.(hookEvent);
    if (!extra) continue;
    if (typeof extra !== 'object') {
      throw new Error(`check '${check.name}' getHookOutputExtraSchema(${hookEvent}) must return an object`);
    }
    if ('copilot' in extra) {
      throw new Error(`check '${check.name}' must not declare top-level 'copilot' field; only its inner fields`);
    }
    for (const [field, fieldSchema] of Object.entries(extra)) {
      if (ownerOf.has(field)) {
        throw new Error(`duplicate copilot field '${field}' declared by both '${ownerOf.get(field)}' and '${check.name}' for ${hookEvent}`);
      }
      ownerOf.set(field, check.name);
      copilotProps[field] = fieldSchema;
    }
  }

  if (Object.keys(copilotProps).length > 0) {
    schema.properties.copilot = {
      type: 'object',
      properties: copilotProps,
      additionalProperties: false,
    };
  }
  return schema;
}

function buildStage1ToolSchema(candidateNames) {
  const flagsItems = { type: 'string' };
  if (candidateNames.length > 0) flagsItems.enum = candidateNames;
  return {
    type: 'object',
    required: ['clear'],
    additionalProperties: false,
    properties: {
      clear: { type: 'boolean' },
      flags: {
        type: 'array',
        items: flagsItems,
        ...(candidateNames.length === 0 ? { maxItems: 0 } : {}),
      },
    },
  };
}

export function buildToolsArray(events, checks) {
  const eventNames = [...events.keys()].sort();
  const tools = [];
  for (const name of eventNames) {
    const evt = events.get(name);
    const candidateNames = discoverCandidateNames(checks, name);
    tools.push({
      name: `stage1_${name}`,
      description: evt.stage1ToolDescription,
      input_schema: buildStage1ToolSchema(candidateNames),
    });
    tools.push({
      name: `stage2_${name}`,
      description: evt.stage2ToolDescription,
      input_schema: composeStage2Schema(evt.hookOutputSchema, checks, name),
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Pipeline context and Anthropic API transport
// ---------------------------------------------------------------------------

function buildCtx(hookInput, transcript, cwd) {
  return {
    hookEvent: hookInput.hook_event_name,
    hookInput,
    messages: transcript.messages,
    hookSuccesses: transcript.hookSuccesses,
    hookAdditionalContexts: transcript.hookAdditionalContexts,
    rawEntries: transcript.rawEntries,
    cwd,
  };
}

let cachedSettingsEnv = null;
function readSettingsEnv() {
  if (cachedSettingsEnv !== null) return cachedSettingsEnv;
  const settingsPath = resolve(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    cachedSettingsEnv = {};
    return cachedSettingsEnv;
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    cachedSettingsEnv = parsed.env ?? {};
  } catch {
    cachedSettingsEnv = {};
  }
  return cachedSettingsEnv;
}

function resolveEnv(name) {
  return process.env[name] ?? readSettingsEnv()[name];
}

function buildAnthropicMessagesBody({ messages, system, tools, tool_choice, thinking, maxTokens }) {
  const rawModel = resolveEnv('AGENT_COPILOT_MODEL') ?? resolveEnv('ANTHROPIC_SMALL_FAST_MODEL');
  if (!rawModel) {
    throw new Error('AGENT_COPILOT_MODEL or ANTHROPIC_SMALL_FAST_MODEL must be set (checked process.env and ~/.claude/settings.json env)');
  }
  return {
    model: rawModel.replace(/\[1m\]$/, ''),
    system,
    tools,
    tool_choice,
    thinking,
    messages,
    max_tokens: maxTokens,
  };
}

function getSessionId(hookInput) {
  if (typeof hookInput?.session_id === 'string' && hookInput.session_id) return hookInput.session_id;
  const tp = hookInput?.transcript_path;
  if (typeof tp === 'string') {
    const base = tp.split('/').pop() ?? '';
    const m = base.match(/^([0-9a-f-]+)\.jsonl$/i);
    if (m) return m[1];
  }
  return null;
}

function appendLogLine(record, sessionId) {
  const dir = resolveEnv('AGENT_COPILOT_LOG_DIR');
  if (!dir || !sessionId) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(dir, `${sessionId}.jsonl`), JSON.stringify(record) + '\n');
  } catch {
    // logging must never break the hook
  }
}

async function sendAnthropicMessages(body, { signal, sessionId } = {}) {
  const baseUrl = resolveEnv('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com';
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  const authToken = resolveEnv('ANTHROPIC_AUTH_TOKEN');
  const apiKey = resolveEnv('ANTHROPIC_API_KEY');
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  } else if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  if (sessionId) headers['x-claude-code-session-id'] = sessionId;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

// ---------------------------------------------------------------------------
// Stage 1
// ---------------------------------------------------------------------------

const STAGE1_TIMEOUT_MS = 30_000;
const STAGE2_TIMEOUT_MS = 90_000;
const STAGE1_MAX_TOKENS = 1024;
const STAGE2_MAX_TOKENS = 16_384;
const STAGE2_THINKING_BUDGET = 8192;

function stage1Prompt(hookEvent, eventText) {
  return (
`You are agent-copilot. The conversation above is the main Claude Code agent's transcript — its user, its assistant turns, its tool calls and results. None of that is yours. Tools that appear in that history (Bash, Read, Edit, Write, Grep, Glob, TodoWrite, Skill, etc.) belong to the main agent and are NOT in your tools array.

This invocation is the ${hookEvent} Stage 1 classification.

${eventText}

You MUST call \`stage1_${hookEvent}\` with \`{clear, flags}\` — do not emit any other tool call, and do not emit free text. This is a single-turn decision: no other tool you call will bring back additional context, so reaching for tools like Bash/Read/Grep/Edit is not just unavailable but also incoherent — decide from what is already visible.`
  );
}

function stage2Prompt(hookEvent, eventText) {
  return (
`Stage 1 just classified which checks need deeper evaluation; the flagged checks' Stage 2 prompts follow. Call \`stage2_${hookEvent}\` with its input populated according to those prompts, and do not emit any other tool call or free text — tools shown in the main agent's transcript (the portion above your Stage 1 turn), such as Bash, Read, Edit, etc., belong to the main agent and are NOT in your tools array. Scale thinking to the case's actual difficulty: trivial cases should resolve quickly, and do not start your thinking over with phrases like "But wait", since this hook is adding extra time on top of the user's wait.

${eventText}`
  );
}

// Stage 1 runs with thinking disabled, so its response carries no thinking
// block. But Stage 2 re-sends the Stage 1 assistant turn with thinking enabled,
// and backends disagree on what that turn may contain: some (deepseek) reject a
// thinking-enabled continuation whose prior assistant turn has no thinking block
// at all, while others (Anthropic) reject a thinking block whose text is empty.
// A short, non-empty thinking block synthesized from the classification result
// satisfies both — and reads as genuine reasoning rather than filler.
function synthesizeStage1Thinking(hookEvent, flags) {
  return `Ok, I'm doing the ${hookEvent} Stage 1 classification. Let me go over the candidate checks against what's visible. ${flags.join(', ')} could plausibly apply here, so I'll flag them for a closer Stage 2 look. The other candidates don't concretely match their criteria, so I'll leave those out.`;
}

function buildStage1Request(ctx, eventModule, checks, { system, tools }) {
  const eventText = eventModule.getStage1Prompt(ctx, checks);
  if (eventText === null) return null;
  const userText = stage1Prompt(ctx.hookEvent, eventText);
  const stage1UserMessage = { role: 'user', content: [{ type: 'text', text: userText }] };
  const body = buildAnthropicMessagesBody({
    messages: [...ctx.messages, stage1UserMessage],
    system,
    tools,
    tool_choice: { type: 'tool', name: `stage1_${ctx.hookEvent}` },
    thinking: { type: 'disabled' },
    maxTokens: STAGE1_MAX_TOKENS,
  });
  return { body, stage1UserMessage };
}

function extractStage1ToolUse(res, hookEvent) {
  const expectedName = `stage1_${hookEvent}`;
  const block = res.content?.find(b => b.type === 'tool_use' && b.name === expectedName);
  if (!block) {
    throw new Error(`Stage 1 response missing tool_use for '${expectedName}'`);
  }
  const input = block.input ?? {};
  if (typeof input.clear !== 'boolean') {
    throw new Error(`Stage 1 tool_use input missing boolean 'clear': ${JSON.stringify(input)}`);
  }
  let flags = [];
  if (!input.clear) {
    if (!Array.isArray(input.flags) || input.flags.length === 0) {
      return { clear: true, flags: [], toolUseBlock: block };
    }
    if (!input.flags.every(f => typeof f === 'string')) {
      throw new Error(`Stage 1 flags must be strings: ${JSON.stringify(input)}`);
    }
    flags = input.flags;
  }
  return { clear: input.clear, flags, toolUseBlock: block };
}

async function runStage1(ctx, eventModule, checks, { system, tools }) {
  const built = buildStage1Request(ctx, eventModule, checks, { system, tools });
  if (built === null) return { clear: true, flags: [], skipped: true };

  const { signal, cancel } = withTimeout(STAGE1_TIMEOUT_MS);
  let res;
  try {
    res = await sendAnthropicMessages(built.body, { signal, sessionId: getSessionId(ctx.hookInput) });
  } finally {
    cancel();
  }
  let extracted;
  try {
    extracted = extractStage1ToolUse(res, ctx.hookEvent);
  } catch (e) {
    e.rawResponse = res;
    throw e;
  }
  const { clear, flags, toolUseBlock } = extracted;
  const hasThinking = res.content?.some(b => b.type === 'thinking');
  const stage1Content = hasThinking
    ? res.content
    : [{ type: 'thinking', thinking: synthesizeStage1Thinking(ctx.hookEvent, flags), signature: '' }, ...res.content];
  const stage1AssistantMessage = { role: 'assistant', content: stage1Content };
  return {
    clear,
    flags,
    skipped: false,
    raw: res,
    stage1UserMessage: built.stage1UserMessage,
    stage1AssistantMessage,
    stage1ToolUseId: toolUseBlock.id,
  };
}

// ---------------------------------------------------------------------------
// Stage 2
// ---------------------------------------------------------------------------

function buildStage2Request(ctx, eventModule, flaggedChecks, stage1, { system, tools }) {
  const eventText = eventModule.getStage2Prompt(ctx, flaggedChecks);
  const toolResultText = stage2Prompt(ctx.hookEvent, eventText);
  const stage2UserMessage = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: stage1.stage1ToolUseId, content: toolResultText }],
  };
  const body = buildAnthropicMessagesBody({
    messages: [
      ...ctx.messages,
      stage1.stage1UserMessage,
      stage1.stage1AssistantMessage,
      stage2UserMessage,
    ],
    system,
    tools,
    // tool_choice: { type: 'auto' },
    thinking: { type: 'enabled', budget_tokens: STAGE2_THINKING_BUDGET },
    maxTokens: STAGE2_MAX_TOKENS,
  });
  return { body, stage2UserMessage };
}

function extractStage2ToolUse(res, hookEvent) {
  const expectedName = `stage2_${hookEvent}`;
  const block = res.content?.find(b => b.type === 'tool_use' && b.name === expectedName);
  if (!block) {
    throw new Error(`Stage 2 response missing tool_use for '${expectedName}'`);
  }
  return block.input ?? {};
}

async function runStage2(ctx, eventModule, flaggedChecks, stage1, { system, tools }) {
  const { body } = buildStage2Request(ctx, eventModule, flaggedChecks, stage1, { system, tools });
  const { signal, cancel } = withTimeout(STAGE2_TIMEOUT_MS);
  let res;
  try {
    res = await sendAnthropicMessages(body, { signal, sessionId: getSessionId(ctx.hookInput) });
  } finally {
    cancel();
  }
  return { output: extractStage2ToolUse(res, ctx.hookEvent), raw: res };
}

// ---------------------------------------------------------------------------
// Pipeline dispatcher
// ---------------------------------------------------------------------------

function synthesizeStage1Result(ctx, eventModule, checks, flags) {
  const eventText = eventModule.getStage1Prompt(ctx, checks);
  if (eventText === null) {
    throw new Error(`event '${ctx.hookEvent}' produced no Stage 1 candidates; cannot synthesize Stage 1 result with explicit flags`);
  }
  const userText = stage1Prompt(ctx.hookEvent, eventText);
  const stage1ToolUseId = 'synthetic_stage1';
  return {
    clear: false,
    flags,
    skipped: false,
    stage1UserMessage: { role: 'user', content: [{ type: 'text', text: userText }] },
    stage1AssistantMessage: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: synthesizeStage1Thinking(ctx.hookEvent, flags), signature: '' },
        {
          type: 'tool_use',
          id: stage1ToolUseId,
          name: `stage1_${ctx.hookEvent}`,
          input: { clear: false, flags },
        },
      ],
    },
    stage1ToolUseId,
  };
}

// ---------------------------------------------------------------------------
// Transcript-readiness wait (tail-follow, tail -f style)
// ---------------------------------------------------------------------------

const READINESS_POLL_STEP_MS = 50;
const READINESS_TIMEOUT_MS = 2000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Split a buffer into complete JSONL lines (each terminated by LF in the file).
 * @param {Buffer} buf
 * @param {boolean} atLineStart — true if buf starts on a line boundary; if false,
 *   the leading partial line (before the first LF) is dropped.
 * @returns {{ lines: string[], consumed: number }} consumed = byte offset just
 *   past the last LF (relative to buf start); buffered partial tail is excluded.
 */
function splitCompleteLines(buf, atLineStart) {
  let from = 0;
  if (!atLineStart) {
    const firstNL = buf.indexOf(LF);
    if (firstNL < 0) return { lines: [], consumed: 0 };
    from = firstNL + 1;
  }
  let lastNL = buf.length - 1;
  while (lastNL >= from && buf[lastNL] !== LF) lastNL--;
  if (lastNL < from) return { lines: [], consumed: from };
  const lines = [];
  let s = from;
  for (let i = from; i <= lastNL; i++) {
    if (buf[i] === LF) {
      if (i > s) lines.push(buf.toString('utf-8', s, i));
      s = i + 1;
    }
  }
  return { lines, consumed: lastNL + 1 };
}

/** Normalize raw JSONL entries into Messages (no merge/prune; tail probe only). */
function tailEntriesToMessages(entries) {
  const messages = [];
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (!entry.message || typeof entry.message !== 'object') continue;
    let raw = entry.message.content;
    if (typeof raw === 'string') {
      if (raw.length === 0) continue;
      raw = [{ type: 'text', text: raw }];
    }
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const content = raw.map(normalizeBlock).filter((b) => b !== null);
    if (content.length === 0) continue;
    messages.push({ role: entry.message.role, content });
  }
  return messages;
}

/**
 * Wait until the transcript tail satisfies `isReady`. Reads the tail chunk once
 * (fast path: already flushed), then follows only newly-appended bytes — like
 * `tail -f`: fstat for growth, read [baseline, EOF), stop when ready or timeout.
 * @returns {Promise<boolean>} true if ready, false on timeout.
 */
async function waitForFlush(transcriptPath, isReady, { step, timeout }) {
  if (!existsSync(transcriptPath)) return false;
  const fd = openSync(transcriptPath, 'r');
  try {
    const entries = [];
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - TAIL_CHUNK_SIZE);
    let baseline = start;
    if (size > start) {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const { lines, consumed } = splitCompleteLines(buf, start === 0);
      for (const l of lines) { try { entries.push(JSON.parse(l)); } catch { /* skip */ } }
      baseline = start + consumed;
    }
    if (isReady(tailEntriesToMessages(entries))) return true;

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await sleep(step);
      const cur = fstatSync(fd).size;
      if (cur <= baseline) continue;
      const buf = Buffer.alloc(cur - baseline);
      readSync(fd, buf, 0, buf.length, baseline);
      const { lines, consumed } = splitCompleteLines(buf, true);
      if (lines.length === 0) continue;
      for (const l of lines) { try { entries.push(JSON.parse(l)); } catch { /* skip */ } }
      baseline += consumed;
      if (isReady(tailEntriesToMessages(entries))) return true;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

export async function runPipeline(hookInput, agentName = 'copilot', diagnostics = null) {
  const cwd = hookInput.cwd ?? process.cwd();
  if (!hookInput.transcript_path) throw new Error('hook input missing transcript_path');

  const events = await loadEvents();
  const checks = await loadChecks(new Set(events.keys()));
  const system = loadAgentSystemPrompt(agentName);

  // Early short-circuit: an event module may settle the hook from the hook
  // input alone, before the transcript is loaded. A returned object is the
  // final hook stdout; undefined continues the full pipeline.
  const earlyEventModule = events.get(hookInput.hook_event_name);
  if (earlyEventModule?.preprocessHookInput) {
    const early = earlyEventModule.preprocessHookInput(hookInput);
    if (early !== undefined) return early;
  }

  let transcript = loadTranscript(hookInput.transcript_path);
  let ctx = buildCtx(hookInput, transcript, cwd);
  const eventModule = events.get(ctx.hookEvent);
  if (!eventModule) return null;

  // Wait for an event-declared readiness condition (e.g. Stop's not-yet-flushed
  // final turn), then rebuild ctx from the now-complete transcript. On timeout,
  // fall through and evaluate the transcript as-is.
  if (eventModule.isTranscriptReady) {
    const ready = await waitForFlush(
      hookInput.transcript_path,
      (tail) => eventModule.isTranscriptReady(ctx, tail),
      { step: READINESS_POLL_STEP_MS, timeout: READINESS_TIMEOUT_MS },
    );
    if (ready) {
      transcript = loadTranscript(hookInput.transcript_path);
      ctx = buildCtx(hookInput, transcript, cwd);
    }
  }

  const tools = buildToolsArray(events, checks);

  const stage1Start = Date.now();
  const stage1 = await runStage1(ctx, eventModule, checks, { system, tools });
  if (diagnostics && !stage1.skipped) {
    diagnostics.stage1 = {
      clear: stage1.clear,
      flags: stage1.flags,
      latency_ms: Date.now() - stage1Start,
    };
  }
  if (stage1.skipped || stage1.clear) return null;

  const flaggedChecks = checks.filter(c => stage1.flags.includes(c.name));
  if (flaggedChecks.length === 0) return null;

  const stage2Start = Date.now();
  const stage2 = await runStage2(ctx, eventModule, flaggedChecks, stage1, { system, tools });
  let output = stage2.output;
  for (const check of flaggedChecks) {
    if (check.postProcessHookOutput) {
      output = check.postProcessHookOutput(output, ctx);
    }
  }
  if (eventModule.postProcessHookOutput) {
    output = eventModule.postProcessHookOutput(output, ctx);
  }
  if (diagnostics) {
    diagnostics.stage2 = {
      latency_ms: Date.now() - stage2Start,
      output,
    };
  }
  return output;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node copilot.js [phase] [sub-phase] [args]

With no phase and stdin piped in, reads a Claude Code hook input JSON from
stdin and runs the full pipeline. Writes the final hook stdout JSON (or '{}'
on fail-open) to stdout and exits 0.

Phases (each runs the named step and prints its output; use sub-phases to
inspect smaller pieces independently, kubeadm-style):

  replay <transcript>             Reconstruct what Claude Code would send.
    replay messages <transcript> [entryUuid]
                                  Reconstruct the messages array only,
                                  optionally stopping at a transcript entry UUID.
    replay claudemd [<cwd>]       Render just the nested_memory (CLAUDE.md) block
                                  that replay would inject at messages[0].

  stage1 <hook-input.json>        Stage 1 classification (non-thinking).
    stage1 request <hook-input.json>
                                  Build and print only the API request body.
    stage1 response <hook-input.json>
                                  Send and print only the API response.

  stage2 <hook-input.json> [comma-flags]
                                  Stage 2 synthesis (thinking). If comma-flags
                                  is omitted, runs Stage 1 first to derive flags.
                                  If provided, skips the Stage 1 API call but
                                  still builds the Stage 1 messages + a synthetic
                                  tool_use carrying the given flags.
    stage2 request <hook-input.json> [comma-flags]
                                  Build and print only the API request body.
    stage2 response <hook-input.json> [comma-flags]
                                  Send and print only the API response.

  pipeline <hook-input.json>      Run Stage 1 + Stage 2 end-to-end. Equivalent
                                  to piping the hook input on stdin.

Examples:
  node copilot.js replay messages ~/.claude/projects/.../session.jsonl
  node copilot.js stage1 fixtures/PreToolUse.json
  node copilot.js stage2 fixtures/Stop.json auto-mode
  cat fixtures/Stop.json | node copilot.js
`;

function cmdReplayMessages(args) {
  const transcriptPath = args[0];
  const untilEntryUuid = args[1] ?? null;
  if (!transcriptPath) {
    console.error('Error: missing transcript path\n\n' + USAGE);
    process.exit(1);
  }
  const { messages } = loadTranscript(transcriptPath, untilEntryUuid);
  console.error(`[loaded ${messages.length} messages]`);
  console.log(JSON.stringify(messages, null, 2));
}

function cmdReplayClaudemd(args) {
  const cwd = args[0] ?? process.cwd();
  const text = renderClaudeMdContext(cwd);
  if (text === null) {
    console.error(`[no CLAUDE.md found at ${cwd}/.claude/CLAUDE.md or ${homedir()}/.claude/CLAUDE.md]`);
    process.exit(1);
  }
  console.log(text);
}

function cmdReplay(args) {
  const sub = args[0];
  switch (sub) {
    case 'messages': return cmdReplayMessages(args.slice(1));
    case 'claudemd': return cmdReplayClaudemd(args.slice(1));
    default:
      if (sub && !sub.startsWith('-')) return cmdReplayMessages(args);
      console.error('Error: replay needs a sub-phase or a transcript path\n\n' + USAGE);
      process.exit(1);
  }
}

async function loadPipelineInputs(hookInputPath, agentName = 'copilot') {
  const hookInput = JSON.parse(readFileSync(hookInputPath, 'utf8'));
  if (!hookInput.transcript_path) {
    console.error('hook input missing transcript_path');
    process.exit(1);
  }
  const transcript = loadTranscript(hookInput.transcript_path);
  const ctx = buildCtx(hookInput, transcript, hookInput.cwd ?? process.cwd());
  const events = await loadEvents();
  const checks = await loadChecks(new Set(events.keys()));
  const eventModule = events.get(ctx.hookEvent);
  if (!eventModule) {
    console.error(`unknown hook_event_name: ${ctx.hookEvent}`);
    process.exit(1);
  }
  const system = loadAgentSystemPrompt(agentName);
  const tools = buildToolsArray(events, checks);
  return { ctx, eventModule, checks, system, tools };
}

async function cmdStage1Request(args) {
  const hookInputPath = args[0];
  if (!hookInputPath) { console.error('Usage: stage1 request <hook-input.json>'); process.exit(1); }
  const { ctx, eventModule, checks, system, tools } = await loadPipelineInputs(hookInputPath);
  const built = buildStage1Request(ctx, eventModule, checks, { system, tools });
  if (built === null) {
    console.log(JSON.stringify({ skipped: true, reason: 'no Stage 1 candidates' }, null, 2));
    return;
  }
  console.log(JSON.stringify(built.body, null, 2));
}

async function cmdStage1Response(args) {
  const hookInputPath = args[0];
  if (!hookInputPath) { console.error('Usage: stage1 response <hook-input.json>'); process.exit(1); }
  const { ctx, eventModule, checks, system, tools } = await loadPipelineInputs(hookInputPath);
  const built = buildStage1Request(ctx, eventModule, checks, { system, tools });
  if (built === null) {
    console.log(JSON.stringify({ skipped: true, reason: 'no Stage 1 candidates' }, null, 2));
    return;
  }
  const { signal, cancel } = withTimeout(STAGE1_TIMEOUT_MS);
  try {
    const res = await sendAnthropicMessages(built.body, { signal, sessionId: getSessionId(ctx.hookInput) });
    console.log(JSON.stringify(res, null, 2));
  } finally {
    cancel();
  }
}

async function cmdStage1Both(args) {
  const hookInputPath = args[0];
  if (!hookInputPath) { console.error('Usage: stage1 <hook-input.json>'); process.exit(1); }
  const { ctx, eventModule, checks, system, tools } = await loadPipelineInputs(hookInputPath);
  const built = buildStage1Request(ctx, eventModule, checks, { system, tools });
  if (built === null) {
    console.log(JSON.stringify({ skipped: true, reason: 'no Stage 1 candidates' }, null, 2));
    return;
  }
  console.log('===== request =====');
  console.log(JSON.stringify(built.body, null, 2));
  const { signal, cancel } = withTimeout(STAGE1_TIMEOUT_MS);
  try {
    const res = await sendAnthropicMessages(built.body, { signal, sessionId: getSessionId(ctx.hookInput) });
    console.log('===== response =====');
    console.log(JSON.stringify(res, null, 2));
  } finally {
    cancel();
  }
}

function cmdStage1(args) {
  const sub = args[0];
  switch (sub) {
    case 'request': return cmdStage1Request(args.slice(1));
    case 'response': return cmdStage1Response(args.slice(1));
    default:
      if (sub && !sub.startsWith('-')) return cmdStage1Both(args);
      console.error('Usage: stage1 [request|response] <hook-input.json>'); process.exit(1);
  }
}

async function resolveStage1ForStage2(ctx, eventModule, checks, commaFlags, { system, tools }) {
  if (commaFlags) {
    const flags = commaFlags.split(',').map(s => s.trim()).filter(Boolean);
    return synthesizeStage1Result(ctx, eventModule, checks, flags);
  }
  return runStage1(ctx, eventModule, checks, { system, tools });
}

async function cmdStage2Request(args) {
  const [hookInputPath, commaFlags] = args;
  if (!hookInputPath) { console.error('Usage: stage2 request <hook-input.json> [comma-flags]'); process.exit(1); }
  const { ctx, eventModule, checks, system, tools } = await loadPipelineInputs(hookInputPath);
  const stage1 = await resolveStage1ForStage2(ctx, eventModule, checks, commaFlags, { system, tools });
  if (stage1.skipped || stage1.clear) {
    console.log(JSON.stringify({ skipped: true, reason: stage1.skipped ? 'no Stage 1 candidates' : 'Stage 1 cleared' }, null, 2));
    return;
  }
  const flaggedChecks = checks.filter(c => stage1.flags.includes(c.name));
  const { body } = buildStage2Request(ctx, eventModule, flaggedChecks, stage1, { system, tools });
  console.log(JSON.stringify(body, null, 2));
}

async function cmdStage2Response(args) {
  const [hookInputPath, commaFlags] = args;
  if (!hookInputPath) { console.error('Usage: stage2 response <hook-input.json> [comma-flags]'); process.exit(1); }
  const { ctx, eventModule, checks, system, tools } = await loadPipelineInputs(hookInputPath);
  const stage1 = await resolveStage1ForStage2(ctx, eventModule, checks, commaFlags, { system, tools });
  if (stage1.skipped || stage1.clear) {
    console.log(JSON.stringify({ skipped: true, reason: stage1.skipped ? 'no Stage 1 candidates' : 'Stage 1 cleared' }, null, 2));
    return;
  }
  const flaggedChecks = checks.filter(c => stage1.flags.includes(c.name));
  const { body } = buildStage2Request(ctx, eventModule, flaggedChecks, stage1, { system, tools });
  const { signal, cancel } = withTimeout(STAGE2_TIMEOUT_MS);
  try {
    const res = await sendAnthropicMessages(body, { signal, sessionId: getSessionId(ctx.hookInput) });
    console.log(JSON.stringify(res, null, 2));
  } finally {
    cancel();
  }
}

async function cmdStage2Both(args) {
  const [hookInputPath, commaFlags] = args;
  if (!hookInputPath) { console.error('Usage: stage2 <hook-input.json> [comma-flags]'); process.exit(1); }
  const { ctx, eventModule, checks, system, tools } = await loadPipelineInputs(hookInputPath);
  const stage1 = await resolveStage1ForStage2(ctx, eventModule, checks, commaFlags, { system, tools });
  if (stage1.skipped || stage1.clear) {
    console.log(JSON.stringify({ skipped: true, reason: stage1.skipped ? 'no Stage 1 candidates' : 'Stage 1 cleared' }, null, 2));
    return;
  }
  const flaggedChecks = checks.filter(c => stage1.flags.includes(c.name));
  const { body } = buildStage2Request(ctx, eventModule, flaggedChecks, stage1, { system, tools });
  console.log('===== request =====');
  console.log(JSON.stringify(body, null, 2));
  const { signal, cancel } = withTimeout(STAGE2_TIMEOUT_MS);
  try {
    const res = await sendAnthropicMessages(body, { signal, sessionId: getSessionId(ctx.hookInput) });
    console.log('===== response =====');
    console.log(JSON.stringify(res, null, 2));
  } finally {
    cancel();
  }
}

function cmdStage2(args) {
  const sub = args[0];
  switch (sub) {
    case 'request': return cmdStage2Request(args.slice(1));
    case 'response': return cmdStage2Response(args.slice(1));
    default:
      if (sub && !sub.startsWith('-')) return cmdStage2Both(args);
      console.error('Usage: stage2 [request|response] <hook-input.json> [comma-flags]'); process.exit(1);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function runPipelineFromInput(hookInput) {
  const t0 = Date.now();
  const diagnostics = { stage1: null, stage2: null };
  let errorRecord = null;
  try {
    const out = await runPipeline(hookInput, 'copilot', diagnostics);
    process.stdout.write((out === null ? '{}' : JSON.stringify(out)) + '\n');
  } catch (e) {
    console.error(e?.stack ?? String(e));
    process.stdout.write('{}\n');
    errorRecord = { message: String(e?.message ?? e), stack: e?.stack ?? null, ...(e?.rawResponse ? { rawResponse: e.rawResponse } : {}) };
  }

  const sessionId = getSessionId(hookInput);
  appendLogLine({
    ts: new Date().toISOString(),
    hook_event: hookInput?.hook_event_name ?? null,
    session_id: sessionId,
    stage1: diagnostics.stage1,
    stage2: diagnostics.stage2,
    error: errorRecord,
    ...(errorRecord ? { hookInput } : {}),
    total_latency_ms: Date.now() - t0,
  }, sessionId);

  process.exit(0);
}

async function cmdPipeline(args) {
  const hookInputPath = args[0];
  if (!hookInputPath) { console.error('Usage: pipeline <hook-input.json>'); process.exit(1); }
  const hookInput = JSON.parse(readFileSync(hookInputPath, 'utf8'));
  return runPipelineFromInput(hookInput);
}

async function main() {
  const [, , phase, ...args] = process.argv;

  if (!phase) {
    if (process.stdin.isTTY) {
      console.error(USAGE);
      process.exit(0);
    }
    let hookInput;
    try {
      hookInput = JSON.parse(await readStdin());
    } catch (e) {
      console.error(e?.stack ?? String(e));
      process.stdout.write('{}\n');
      process.exit(0);
    }
    return runPipelineFromInput(hookInput);
  }

  switch (phase) {
    case 'replay': return cmdReplay(args);
    case 'stage1': return cmdStage1(args);
    case 'stage2': return cmdStage2(args);
    case 'pipeline': return cmdPipeline(args);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

// Run main() when invoked directly. Compare real paths so this still triggers
// when the script is symlinked (e.g. via stow into ~/.claude/hooks/).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve(main()).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
