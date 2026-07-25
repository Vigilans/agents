// Claude Code settings file loading: user + project, read fresh on every
// invocation. Project allow rules are honored despite the workspace-trust
// caveat — a wrongly-skipped review costs one copilot evaluation, never a
// wrong approval, because deny/ask rules (which trust does not gate) are
// checked first.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function readSettings(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// loadPermissionSources(cwd) → [{ path, permissions }]
// permissions is the raw `permissions` object from each settings file
// ({ allow, ask, deny, additionalDirectories, ... }), or the file is skipped.
// AGENT_COPILOT_CLAUDE_USER_ROOT overrides ~/.claude, the same knob the
// CLAUDE.md loader uses, so a test fixture pins both from one directory.
export function loadPermissionSources(cwd) {
  const userRoot = process.env.AGENT_COPILOT_CLAUDE_USER_ROOT || resolve(homedir(), '.claude');
  const sources = [];
  for (const path of [
    resolve(userRoot, 'settings.json'),
    resolve(cwd, '.claude', 'settings.json'),
    resolve(cwd, '.claude', 'settings.local.json'),
  ]) {
    const permissions = readSettings(path)?.permissions;
    if (permissions) sources.push({ path, permissions });
  }
  return sources;
}
