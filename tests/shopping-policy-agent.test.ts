import { readFile } from 'node:fs/promises';
import { Agent, MCPServerStdio } from '@openai/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_ROOT, POLICY_TOOL, runShoppingPolicyDemo } from '../src/demo/shopping-policy-agent.js';
import { main } from '../src/scripts/demo-agent.js';

const input = { question: 'Can I buy from Example?', policy: 'My purchasing policy' };
function fixture(decision: 'PASS' | 'FAIL' | 'UNKNOWN' = 'PASS') {
  const value = { decision, reason: decision === 'PASS' ? 'threshold_met' : decision === 'FAIL' ? 'threshold_exceeded' : 'missing_evidence',
    policy: { id: 'policy-id', name: input.policy }, subject: { brand: 'Example' } };
  const call = vi.fn().mockResolvedValue({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
  const fake = { connect: vi.fn(), close: vi.fn(), callToolResult: call };
  const createServer = vi.fn(() => fake as unknown as MCPServerStdio);
  const execute = vi.fn(async (agent: Agent, _prompt: string) => {
    expect(fake.connect).toHaveBeenCalledTimes(1);
    await agent.mcpServers[0]!.callToolResult!(POLICY_TOOL, { brand: 'Example', policy: input.policy });
    return { finalOutput: 'Model prose is not a decision source.' };
  });
  return { value, call, fake, deps: { apiKey: 'test-key-only', createServer, execute } };
}
afterEach(() => vi.restoreAllMocks());
describe('agent demo through mocked MCP', () => {
  it.each(['PASS', 'FAIL', 'UNKNOWN'] as const)('surfaces %s unchanged from actual tool output, never final prose', async decision => {
    const { value, call, fake, deps } = fixture(decision);
    const output = await runShoppingPolicyDemo(input, deps);
    expect(output).toEqual({ ...input, tool_called: true, tool_name: POLICY_TOOL, decision, reason: value.reason, answer: 'Model prose is not a decision source.' });
    expect(call).toHaveBeenCalledExactlyOnceWith(POLICY_TOOL, { brand: 'Example', policy: input.policy });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it('launches the existing stdio MCP from the repository, forces tool use and supplies exact application policy', async () => {
    const { deps } = fixture(); await runShoppingPolicyDemo(input, deps);
    expect(deps.createServer).toHaveBeenCalledWith(expect.objectContaining({ command: 'npm', args: ['run', 'mcp:stdio'], cwd: DEMO_ROOT, useStructuredContent: true }));
    expect(DEMO_ROOT).toBe(new URL('../', import.meta.url).pathname);
    const [agent, prompt] = deps.execute.mock.calls[0]!;
    expect(agent.name).toBe('Values Shopping Assistant');
    expect(agent.modelSettings.toolChoice).toBe(POLICY_TOOL); expect(agent.resetToolChoice).toBe(true);
    expect(agent.instructions).toContain(JSON.stringify(input.policy));
    expect(prompt).toBe(`Selected purchasing policy: ${JSON.stringify(input.policy)}\nUser question: ${JSON.stringify(input.question)}`);
    expect(JSON.stringify(deps.createServer.mock.calls)).not.toContain('test-key-only');
  });
  it('rejects a model-substituted policy before the tool is sent', async () => {
    const { deps, call, fake } = fixture();
    deps.execute.mockImplementation(async agent => {
      await agent.mcpServers[0]!.callToolResult!(POLICY_TOOL, { brand: 'Example', policy: 'Other' });
      return { finalOutput: 'PASS' };
    });
    await expect(runShoppingPolicyDemo(input, deps)).rejects.toThrow('No verified policy answer');
    expect(call).not.toHaveBeenCalled(); expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it('fails if the model claims PASS without invoking the tool', async () => {
    const { deps, fake } = fixture(); deps.execute.mockResolvedValue({ finalOutput: 'PASS' });
    await expect(runShoppingPolicyDemo(input, deps)).rejects.toThrow('No verified policy answer');
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it('closes on model failure and never exposes exception details', async () => {
    const { deps, fake } = fixture(); deps.execute.mockRejectedValue(new Error('secret-key Authorization Bearer private'));
    const log = vi.spyOn(console, 'log'); const stderr = vi.spyOn(console, 'error');
    await expect(runShoppingPolicyDemo(input, deps)).rejects.toThrow(/^Agent demo failed\. No verified policy answer is available\.$/);
    expect(fake.close).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
  });
  it('closes even when connection fails', async () => {
    const { deps, fake } = fixture(); fake.connect.mockRejectedValue(new Error('private'));
    await expect(runShoppingPolicyDemo(input, deps)).rejects.toThrow('Agent demo failed');
    expect(deps.execute).not.toHaveBeenCalled(); expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it.each([{ isError: true, content: [] }, { content: [{ type: 'text', text: 'not json' }] },
    { structuredContent: { decision: 'PASS' }, content: [] }])('rejects failed or malformed tool results', async result => {
    const { deps, call, fake } = fixture(); call.mockResolvedValue(result);
    await expect(runShoppingPolicyDemo(input, deps)).rejects.toThrow('Agent demo failed');
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
  it('supports the same JSON decision in a text-only MCP response', async () => {
    const { deps, call, value } = fixture('UNKNOWN'); call.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    expect(await runShoppingPolicyDemo(input, deps)).toMatchObject({ decision: 'UNKNOWN', reason: 'missing_evidence' });
  });
  it('rejects repeated tool calls rather than attaching a single decision to a multi-brand answer', async () => {
    const { deps, call } = fixture();
    deps.execute.mockImplementation(async agent => {
      await agent.mcpServers[0]!.callToolResult!(POLICY_TOOL, { brand: 'Example', policy: input.policy });
      await agent.mcpServers[0]!.callToolResult!(POLICY_TOOL, { brand: 'Other', policy: input.policy });
      return { finalOutput: 'Both pass.' };
    });
    await expect(runShoppingPolicyDemo(input, deps)).rejects.toThrow('Agent demo failed');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('rejects a mismatched policy in the tool response', async () => {
    const { deps, call, value } = fixture();
    call.mockResolvedValue({ structuredContent: { ...value, policy: { id: 'other', name: 'Other' } }, content: [] });
    await expect(runShoppingPolicyDemo(input, deps)).rejects.toThrow('Agent demo failed');
  });
  it('supports a model override', async () => {
    const { deps } = fixture(); await runShoppingPolicyDemo({ ...input, model: 'test-model' }, deps);
    expect(deps.execute.mock.calls[0]![0].model).toBe('test-model');
  });
  it('fails before connecting when key is absent', async () => {
    const { deps } = fixture();
    await expect(runShoppingPolicyDemo(input, { ...deps, apiKey: undefined })).rejects.toThrow('OPENAI_API_KEY is required');
    expect(deps.createServer).not.toHaveBeenCalled();
  });
});
describe('demo CLI', () => {
  it.each([[], ['--policy', 'Policy'], ['--policy', ' ', '--question', 'Question'], ['--policy', 'Policy', '--question', '']].map(args => ({ args })))('validates $args before accessing configuration', async ({ args }) => {
    const environment = vi.fn();
    await expect(main(args, { environment })).rejects.toThrow(); expect(environment).not.toHaveBeenCalled();
  });
  it('rejects missing API key without executing', async () => {
    const execute = vi.fn();
    await expect(main(['--policy', input.policy, '--question', input.question], { environment: () => ({}), execute })).rejects.toThrow('OPENAI_API_KEY is required for the agent demo.');
    expect(execute).not.toHaveBeenCalled();
  });
  it('prints only the inspectable result', async () => {
    const result = { ...input, decision: 'UNKNOWN' as const, reason: 'missing_evidence', answer: 'Cannot determine.', tool_called: true, tool_name: POLICY_TOOL };
    const execute = vi.fn().mockResolvedValue(result); const log = vi.fn();
    await main(['--policy', input.policy, '--question', input.question], { environment: () => ({ OPENAI_API_KEY: 'private-test-key' }), execute, log });
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result, null, 2));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-test-key');
  });
});
it('the demo has no direct engine/database/policy dependencies', async () => {
  const source = await readFile(new URL('../src/demo/shopping-policy-agent.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/evaluateBrandDecision|from ['"].*(?:\/db\/|\/evaluation\/|\/decision\/|\/policies\/)/);
  expect(source).toContain('MCPServerStdio'); expect(source).toContain('run(configuredAgent');
});
