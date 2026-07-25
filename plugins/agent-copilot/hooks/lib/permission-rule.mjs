// Permission-rule matching for agent-copilot's PreToolUse short-circuit.
//
// Replicates the subset of Claude Code's permission evaluation needed to
// decide "will this tool call be approved without a prompt":
//   deny/ask rule hit (user or project settings) → not auto-approved
//   built-in read-only Bash command → auto-approved
//   user-settings allow rule hit    → auto-approved
//
// Rule syntax (https://code.claude.com/docs/en/permissions):
//   "Tool"              whole-tool rule
//   "Bash(<glob>)"      * matches any chars including spaces; trailing " *"
//                       or ":*" enforces a word boundary
//   "Edit(<path>)"      gitignore-subset path pattern (* within a segment,
//   "Write(<path>)"     ** across segments); anchors: //abs, ~/home,
//                       /settings-file-dir, bare = cwd-relative
//
// Anything unparseable answers "not auto-approved" — never a wrong approval.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep, dirname } from 'node:path';
import { loadPermissionSources } from './settings.mjs';

// ---------------------------------------------------------------------------
// Load + parse rules from settings sources
// ---------------------------------------------------------------------------

function loadPermissions(cwd) {
  const out = { deny: [], ask: [], allow: [] };
  for (const { path, permissions } of loadPermissionSources(cwd)) {
    const anchorDir = dirname(path);
    for (const kind of ['deny', 'ask', 'allow']) {
      for (const rule of permissions[kind] ?? []) {
        const parsed = parseRule(rule, anchorDir);
        if (parsed) out[kind].push(parsed);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule parsing
// ---------------------------------------------------------------------------

function parseRule(rule, anchorDir) {
  if (typeof rule !== 'string' || rule === '') return null;
  const m = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/.exec(rule);
  if (!m) return null;
  const [, tool, arg] = m;
  return { tool, arg: arg ?? null, anchorDir };
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

function ruleMatches(rule, call, cwd) {
  if (rule.tool !== call.toolName) return false;
  if (rule.arg === null) return true; // whole-tool rule

  switch (rule.tool) {
    case 'Bash':
      return bashPatternMatches(rule.arg, call.toolInput.command);
    case 'Edit':
    case 'Write': {
      const path = call.toolInput?.file_path;
      if (typeof path !== 'string') return false;
      return pathRuleMatches(rule, path, cwd);
    }
    default:
      return false; // MCP/agent-scoped/unknown rules: unhandled
  }
}

// A tool call is matched part by part. Every tool is a single part, except
// Bash, whose subcommands are each validated independently by Claude Code.
function toolCallParts(call) {
  if (call.toolName !== 'Bash') return [call];
  const command = call.toolInput?.command;
  if (typeof command !== 'string') return null;
  const subs = splitSubcommands(command)?.map(stripWrappers);
  if (!subs || subs.includes(null)) return null;
  return subs.map((sub) => ({ toolName: 'Bash', toolInput: { command: sub } }));
}

// deny and ask fire on a single offending part; allow has to account for every
// part, and different parts may be covered by different rules.

function anyPartMatches(rules, call, cwd) {
  const parts = toolCallParts(call);
  return parts !== null && parts.some((p) => rules.some((r) => ruleMatches(r, p, cwd)));
}

function allPartsMatch(rules, call, cwd) {
  const parts = toolCallParts(call);
  return parts !== null && parts.every((p) => rules.some((r) => ruleMatches(r, p, cwd)));
}

// --- Bash -------------------------------------------------------------------

// Split on shell operators outside quotes. Returns null for constructs we
// refuse to reason about — caller won't approve.
export function splitSubcommands(command) {
  if (/[$`<>]/.test(command)) return null;
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '|&') { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quote) return null;
  parts.push(cur);
  const subs = parts.map((s) => s.trim()).filter(Boolean);
  return subs.length > 0 ? subs : null;
}

const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']);
const SAFE_ENV_PREFIX = /^(?:NODE_ENV|CI|DEBUG|LANG|LC_ALL|TZ|FORCE_COLOR|NO_COLOR)=[^\s]*$/;

function stripWrappers(sub) {
  const tokens = sub.split(/\s+/).filter(Boolean);
  let i = 0;
  for (;;) {
    if (i < tokens.length && SAFE_ENV_PREFIX.test(tokens[i])) { i++; continue; }
    const t = tokens[i];
    if (t && WRAPPERS.has(t)) { i += t === 'timeout' ? 2 : 1; continue; }
    break;
  }
  const rest = tokens.slice(i).join(' ');
  return rest || null;
}

const escapeRegex = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

// Claude Code Bash glob: `*` matches any chars including spaces; trailing
// " *" or ":*" additionally requires a word boundary (or end of string).
export function bashGlobToRegex(glob) {
  let g = glob;
  let wordBoundary = false;
  if (g.endsWith(':*')) { g = g.slice(0, -2); wordBoundary = true; }
  else if (g.endsWith(' *')) { g = g.slice(0, -2); wordBoundary = true; }
  const body = g.split('*').map(escapeRegex).join('.*');
  return new RegExp(`^${body}${wordBoundary ? '(?:\\s.*)?' : ''}$`);
}

const bashGlobCache = new Map();
function bashPatternMatches(pattern, sub) {
  if (!pattern.includes('*')) return pattern === sub;
  let re = bashGlobCache.get(pattern);
  if (!re) { re = bashGlobToRegex(pattern); bashGlobCache.set(pattern, re); }
  return re.test(sub);
}

// --- Paths --------------------------------------------------------------------

// Minimal gitignore subset: `*` within a segment, `**` across segments, four
// anchor forms. Patterns containing `!` or `[` are rejected (no approval).
function pathRuleMatches(rule, targetPath, cwd) {
  const pattern = rule.arg;
  if (/[![]/.test(pattern)) return false;
  let base;
  let pat = pattern;
  if (pat.startsWith('//')) { base = '/'; pat = pat.slice(2); }
  else if (pat.startsWith('~/')) { base = homedir(); pat = pat.slice(2); }
  else if (pat.startsWith('/')) { base = rule.anchorDir; pat = pat.slice(1); }
  else { base = cwd; }
  const absTarget = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
  let realTarget = absTarget;
  try { realTarget = realpathSync(absTarget); } catch { /* nonexistent: match syntactically */ }
  const rel = relativeTo(base, realTarget) ?? relativeTo(base, absTarget);
  if (rel === null) return false;
  return gitignoreMatch(pat, rel);
}

function relativeTo(base, target) {
  const b = resolve(base);
  const t = resolve(target);
  if (t === b) return '';
  const prefix = b.endsWith(sep) ? b : b + sep;
  return t.startsWith(prefix) ? t.slice(prefix.length) : null;
}

export function gitignoreMatch(pattern, relPath) {
  const patSegs = pattern.split('/').filter(Boolean);
  const pathSegs = relPath.split('/').filter(Boolean);
  return matchSegs(patSegs, pathSegs);
}

function matchSegs(pats, segs) {
  if (pats.length === 0) return segs.length === 0;
  if (pats[0] === '**') {
    for (let skip = 0; skip <= segs.length; skip++) {
      if (matchSegs(pats.slice(1), segs.slice(skip))) return true;
    }
    return false;
  }
  if (segs.length === 0) return false;
  if (!segmentMatches(pats[0], segs[0])) return false;
  return matchSegs(pats.slice(1), segs.slice(1));
}

function segmentMatches(pat, seg) {
  const re = new RegExp(`^${pat.split('*').map(escapeRegex).join('[^/]*')}$`);
  return re.test(seg);
}

// ---------------------------------------------------------------------------
// Built-in read-only Bash commands, synthesized as rules so they match through
// the same pipeline as user allow rules. Commands with dangerous-flag callbacks
// (sed/find/sort/xargs/git…) are excluded — their safe forms can't be expressed
// as a blanket rule.
// ---------------------------------------------------------------------------

const BUILTIN_READONLY_BASH_RULES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'grep', 'egrep', 'fgrep', 'rg',
  'diff', 'du', 'df', 'echo', 'printf', 'strings', 'hexdump', 'od', 'nl',
  'cut', 'column', 'tr', 'tac', 'rev', 'cmp', 'basename', 'dirname',
  'realpath', 'readlink', 'sha256sum', 'sha1sum', 'md5sum', 'pwd', 'tree',
  'pgrep', 'base64', 'which', 'true', 'false',
].flatMap((cmd) => [
  { tool: 'Bash', arg: cmd, anchorDir: '/' },
  { tool: 'Bash', arg: `${cmd}:*`, anchorDir: '/' },
]);

// ---------------------------------------------------------------------------
// Top-level decision, mirroring the real order:
// deny/ask rules → built-in + user allow rules.
// Conservative by construction: a wrong "pre-approved" only defers the call
// to Claude Code's own permission flow, which still prompts when it should.
// ---------------------------------------------------------------------------

export function isPreApproved(toolName, toolInput, cwd) {
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    return true; // always deferred; Claude Code's permission flow decides.
  }
  const call = { toolName, toolInput };
  const perms = loadPermissions(cwd);
  if (anyPartMatches(perms.deny, call, cwd)) return false;
  if (anyPartMatches(perms.ask, call, cwd)) return false;
  return allPartsMatch([...BUILTIN_READONLY_BASH_RULES, ...perms.allow], call, cwd);
}
