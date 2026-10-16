// A turn stopped by the Claude usage limit ("You've hit your session limit · resets 9:40pm (...)")
// parks its task with the reset time instead of a plain "blocked", and the task runs again on its
// own once the limit has reset, including after a Foreman restart.
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { limitBlockedReason, retryAtFromReason } from '../src/agents/usagelimit.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
const tools = (o: Options) => (o.mcpServers!.agentcraft as unknown as ToolServer).instance._registeredTools;
const callTool = async (o: Options, name: string, args: Record<string, unknown>) => (await tools(o)[name]!.handler(args, {})).content.map((c) => c.text).join('\n');
const S = '33333333-3333-4333-8333-333333333333';
const m = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: S, ...o }) as unknown as SDKMessage;

/** Workers: the first `limited` turns fail with the usage limit, later ones end normally. The lead plans one task. */
function fake(state: { workerTurns: number; limited: number; message: string; leadLimited?: boolean }) {
  return ({ prompt, options }: { prompt: unknown; options: Options }) => {
    const lead = 'create_task' in tools(options);
    if (!lead) state.workerTurns++;
    const fail = lead ? !!state.leadLimited : state.workerTurns <= state.limited;
    async function* run(): AsyncGenerator<SDKMessage> {
      yield m({ type: 'system', subtype: 'init', session_id: S, model: 'fake', cwd: '', tools: [] });
      if (lead && String(prompt).startsWith('New goal')) await callTool(options, 'create_task', { title: 'Add a version flag', description: 'x', assignee: 'kit' });
      if (fail) throw new Error(`Claude Code returned an error result: ${state.message}`);
      yield m({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, session_id: S, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
    }
    return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x' }) });
  };
}

const home = tempDir();
let repoPath = '';
const harnesses: Harness[] = [];

afterAll(async () => {
  for (const h of harnesses) await h.fm.close().catch(() => undefined);
  rmrf(home);
  if (repoPath) rmrf(path.dirname(repoPath));
});

describe('claude backend: usage limit', () => {
  it('parks the task with the reset time, then retries it after a restart past the reset', async () => {
    repoPath = await demoRepo();
    // reset an hour from now, in the message's own zone
    const soon = new Date(Date.now() + 3600_000);
    const hhmm = soon.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
    const state = { workerTurns: 0, limited: 1, message: `You've hit your session limit · resets ${hhmm} (UTC)` };

    const h1 = makeForeman(home, ['--backend', 'claude', '--workers', 'kit', '--repo', repoPath]);
    harnesses.push(h1);
    await h1.fm.start(new ClaudeBackend(h1.fm, h1.cfg.claude, { queryFn: fake(state) as never, skipAuthCheck: true }));
    await h1.fm.submitGoal('Add a version flag');
    await until(() => h1.fm.tasks.list().length === 1);
    const t = h1.fm.tasks.list()[0]!;

    await until(() => h1.fm.tasks.get(t.id)!.status === 'blocked');
    const parked = h1.fm.tasks.get(t.id)!;
    const retryAt = retryAtFromReason(parked.blockedReason);
    expect(retryAt).toBeDefined();
    expect(Math.abs(retryAt!.getTime() - soon.getTime())).toBeLessThan(61_000); // to the minute
    expect(h1.fm.agent('kit')!.activity).toMatch(/usage limit - back at/);
    expect(h1.events.some((e) => e.type === 'notify' && e.level === 'warn' && /retrying automatically after/.test(e.text))).toBe(true);
    expect(state.workerTurns).toBe(1); // nothing retried before the reset
    await new Promise((r) => setTimeout(r, 300));
    expect(state.workerTurns).toBe(1);
    expect(h1.fm.tasks.get(t.id)!.status).toBe('blocked');

    // the Foreman stops; when it starts again the reset has passed: the task goes straight back to work
    h1.fm.tasks.update(t.id, { blockedReason: limitBlockedReason(new Date(Date.now() - 60_000)) });
    await h1.fm.close();
    const h2 = makeForeman(home, ['--backend', 'claude', '--workers', 'kit', '--repo', repoPath]);
    harnesses.push(h2);
    await h2.fm.start(new ClaudeBackend(h2.fm, h2.cfg.claude, { queryFn: fake(state) as never, skipAuthCheck: true }));
    await until(() => state.workerTurns >= 2);
    expect(h2.fm.store.data.feed.some((f) => /queued again: the Claude usage limit has reset/.test(f.text))).toBe(true);
  });

  it('leaves other failures for the user to retry', async () => {
    const state = { workerTurns: 0, limited: 1, message: 'some other error' };
    const home2 = tempDir();
    const repo2 = await demoRepo();
    const h = makeForeman(home2, ['--backend', 'claude', '--workers', 'kit', '--repo', repo2]);
    harnesses.push(h);
    try {
      await h.fm.start(new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fake(state) as never, skipAuthCheck: true }));
      await h.fm.submitGoal('Add a version flag');
      await until(() => h.fm.tasks.list().length === 1);
      const t = h.fm.tasks.list()[0]!;
      await until(() => h.fm.tasks.get(t.id)!.status === 'blocked');
      expect(h.fm.tasks.get(t.id)!.blockedReason).toMatch(/^session ended/);
      expect(retryAtFromReason(h.fm.tasks.get(t.id)!.blockedReason)).toBeUndefined();
    } finally {
      await h.fm.close();
      rmrf(home2);
      rmrf(path.dirname(repo2));
    }
  });

  it("keeps a goal planning when the lead's planning turn hits the limit, instead of failing it", async () => {
    const state = { workerTurns: 0, limited: 0, leadLimited: true, message: "You've hit your session limit · resets 11:59pm (UTC)" };
    const home3 = tempDir();
    const repo3 = await demoRepo();
    const h = makeForeman(home3, ['--backend', 'claude', '--workers', 'kit', '--repo', repo3]);
    harnesses.push(h);
    try {
      await h.fm.start(new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fake(state) as never, skipAuthCheck: true }));
      const goal = await h.fm.submitGoal('Add a version flag');
      await until(() => h.fm.store.data.feed.some((f) => /Marlow hit the Claude usage limit; his plan turn runs again/.test(f.text)));
      await new Promise((r) => setTimeout(r, 200));
      expect(h.fm.goal(goal.id)!.status).toBe('planning');
      expect(h.fm.agent('marlow')!.activity).toMatch(/usage limit - back at/);
    } finally {
      await h.fm.close();
      rmrf(home3);
      rmrf(path.dirname(repo3));
    }
  });
});
