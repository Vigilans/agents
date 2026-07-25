#!/usr/bin/env node
/**
 * Scenario runner for agent-copilot tests. See README.md.
 *
 * For each tests/fixtures/<scenario>/, feeds hook-input.json (with
 * transcript_path resolved to the scenario's transcript.jsonl) through the
 * pipeline and asserts the emitted hook stdout against expect.json.
 *
 * Assertions cover the outcome only. Which stage produced it is reported, not
 * asserted: a scenario that clears at Stage 1 today may flag and clear at
 * Stage 2 under a different model, with the same verdict at higher cost. That
 * is a cost regression to notice, not a test failure.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const COPILOT_JS = resolve(TESTS_DIR, '..', 'hooks', 'copilot.js');

const only = process.argv.slice(2);

function* scenarios() {
  const dir = resolve(TESTS_DIR, 'fixtures');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    if (only.length > 0 && !only.includes(name.name)) continue;
    yield name.name;
  }
}

function loadExpect(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Claude Code stamps every transcript entry with the cwd it was recorded in,
// and that cwd is where CLAUDE.md is read from. Synthetic fixtures write the
// portable placeholder "." and get it rewritten to the scenario's project dir
// here, in a temp copy — the committed fixture stays machine-independent.
//
// A scenario that settles before the transcript is read (permission
// short-circuits) needs no transcript.jsonl at all.
function materializeTranscript(dir, cwd) {
  const src = join(dir, 'transcript.jsonl');
  if (!existsSync(src)) return src;
  const raw = readFileSync(src, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  let rewrote = false;
  const out = lines.map((line) => {
    const entry = JSON.parse(line);
    if (entry.cwd === '.') {
      entry.cwd = cwd;
      rewrote = true;
      return JSON.stringify(entry);
    }
    return line;
  });
  if (!rewrote) return src;
  const tmp = join(mkdtempSync(join(tmpdir(), 'copilot-tr-')), 'transcript.jsonl');
  writeFileSync(tmp, out.join('\n') + '\n');
  return tmp;
}

function runScenario(name) {
  const dir = resolve(TESTS_DIR, 'fixtures', name);
  const hookInput = JSON.parse(readFileSync(join(dir, 'hook-input.json'), 'utf8'));
  // cwd may be relative (e.g. ./project-cwd) so the fixture carries its own
  // project-level CLAUDE.md snapshot; resolve it against the fixture dir.
  if (typeof hookInput.cwd === 'string' && hookInput.cwd.startsWith('.')) {
    hookInput.cwd = resolve(dir, hookInput.cwd);
  }
  hookInput.transcript_path = materializeTranscript(dir, hookInput.cwd);

  // The pipeline writes its per-stage diagnostics to AGENT_COPILOT_LOG_DIR.
  // Point it at a throwaway dir: keeps the real log clean and gives the runner
  // the stage breakdown without a second code path.
  const logDir = mkdtempSync(join(tmpdir(), 'copilot-test-'));
  const env = {
    ...process.env,
    // The fixture dir is the user root: its CLAUDE.md and .claude/settings.json
    // stand in for the ones under ~, so recall and permission rules never drift
    // with the live files.
    AGENT_COPILOT_CLAUDE_USER_ROOT: dir,
    AGENT_COPILOT_LOG_DIR: logDir,
  };

  try {
    let stdout;
    try {
      // Invoke with no phase: copilot.js reads the hook input from stdin and runs
      // the full pipeline (runPipelineFromInput). execFileSync's `input` pipes it.
      // Stdin (not `pipeline <file>`) is what carries the runner's resolved
      // transcript_path and cwd.
      stdout = execFileSync('node', [COPILOT_JS], {
        input: JSON.stringify(hookInput),
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // The pipeline logs fail-open stack traces to stderr; keep them out of
        // the report (the diagnostics record carries the message).
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      return { name, ok: false, error: `pipeline crashed: ${e.message}` };
    }

    let output;
    try {
      output = JSON.parse(stdout.trim());
    } catch {
      return { name, ok: false, error: `hook stdout not JSON: ${stdout.slice(0, 200)}` };
    }

    const expect = loadExpect(join(dir, 'expect.json'));
    return { name, ...assertScenario(output, expect), output, stages: readStages(logDir) };
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

// Read the diagnostics the pipeline logged for this run: {stage1, stage2},
// either of which is null when that stage never ran.
function readStages(logDir) {
  for (const f of readdirSync(logDir)) {
    const lines = readFileSync(join(logDir, f), 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length > 0) return JSON.parse(lines[lines.length - 1]);
  }
  return null;
}

// Human-readable cost trace: where the verdict came from and what it cost.
// A pipeline error is surfaced here because it fails open to '{}', which is
// otherwise indistinguishable from the model deciding not to intervene.
function formatStages(rec) {
  if (!rec) return '';
  const { stage1, stage2, error } = rec;
  const parts = [];
  if (stage1) {
    const what = stage1.clear ? 'clear' : `flag[${(stage1.flags ?? []).join(',')}]`;
    parts.push(`stage1 ${what} ${(stage1.latency_ms / 1000).toFixed(1)}s`);
  }
  if (stage2) parts.push(`stage2 ${(stage2.latency_ms / 1000).toFixed(1)}s`);
  if (error) parts.push(`FAILED OPEN: ${error.message}`);
  if (parts.length === 0) return 'short-circuit (no API)';
  return parts.join(' → ');
}

// Assert the outcome — the hook stdout Claude Code would act on. Which stage
// produced it is deliberately not asserted; see the file header.
function assertScenario(output, expect) {
  const failures = [];
  const want = expect.outcome;
  if (want) {
    const empty = Object.keys(output).length === 0;
    // An empty '{}' means "no intervention". That is the CORRECT answer for a
    // pure mustNotContain scenario (e.g. should-not-block). It is only a
    // fail-open error when the scenario actually requires output — a decision,
    // a permissionDecision, or mustContain content.
    const requiresOutput =
      want.intervenes === true ||
      want.decision !== undefined ||
      want.permissionDecision !== undefined ||
      (want.mustContain ?? []).length > 0;
    if (empty && requiresOutput) {
      failures.push('pipeline produced empty {} but the scenario requires a decision/output (likely fail-open or an early clear)');
      return { ok: false, failures };
    }
    // `intervenes` asserts only whether the call was held up, not which shape
    // that took: deny vs ask is a conservatism dial the model is allowed to
    // move, and both stop the agent. Pin the exact shape with
    // `permissionDecision`/`decision` when a scenario really depends on it.
    if (want.intervenes !== undefined) {
      const held = interventionOf(output);
      if (want.intervenes === false && held !== null) {
        failures.push(`expected no intervention, got ${held}`);
      }
      if (want.intervenes === true && held === null) {
        failures.push('expected an intervention, but the call was let through');
      }
    }
    if (want.decision !== undefined && output.decision !== want.decision) {
      failures.push(`decision: expected ${JSON.stringify(want.decision)}, got ${JSON.stringify(output.decision)}`);
    }
    const pd = output.hookSpecificOutput?.permissionDecision;
    if (want.permissionDecision !== undefined && pd !== want.permissionDecision) {
      failures.push(`permissionDecision: expected ${JSON.stringify(want.permissionDecision)}, got ${JSON.stringify(pd)}`);
    }
    const text = JSON.stringify(output);
    for (const needle of want.mustContain ?? []) {
      if (!text.includes(needle)) failures.push(`mustContain missing: ${JSON.stringify(needle)}`);
    }
    for (const needle of want.mustNotContain ?? []) {
      if (text.includes(needle)) failures.push(`mustNotContain present: ${JSON.stringify(needle)}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// What, if anything, this output does to hold the agent up — the union of the
// per-event intervention shapes. null when it lets the agent proceed.
function interventionOf(output) {
  if (output.decision === 'block') return 'decision=block';
  const pd = output.hookSpecificOutput?.permissionDecision;
  if (pd === 'deny' || pd === 'ask') return `permissionDecision=${pd}`;
  if (output.continue === false) return 'continue=false';
  return null;
}

const results = [];
for (const name of scenarios()) {
  process.stderr.write(`running ${name}... `);
  const r = runScenario(name);
  results.push(r);
  const trace = formatStages(r.stages);
  process.stderr.write(`${r.ok ? 'ok' : 'FAIL'}${trace ? `    ${trace}` : ''}\n`);
}

let failed = 0;
for (const r of results) {
  if (r.ok) continue;
  failed++;
  console.log(`\n=== ${r.name} ===`);
  if (r.error) console.log(`  error: ${r.error}`);
  if (r.stages?.error) {
    console.log(`  pipeline failed open (infrastructure, not a verdict change): ${r.stages.error.message}`);
  }
  for (const f of r.failures ?? []) console.log(`  - ${f}`);
  if (r.output !== undefined) console.log(`  output: ${JSON.stringify(r.output).slice(0, 400)}`);
}

// Cost summary: how many scenarios needed the expensive second stage, and how
// many never reached the model at all.
const escalated = results.filter((r) => r.stages?.stage2).length;
const shortCircuited = results.filter((r) => r.stages && !r.stages.stage1 && !r.stages.stage2).length;
console.log(`\n${results.length - failed}/${results.length} passed  (${escalated} reached stage 2, ${shortCircuited} short-circuited)`);
process.exit(failed === 0 ? 0 : 1);
