import { parseArgs } from 'node:util';
import { AgentDemoError, runShoppingPolicyDemo, validateDemoInput } from '../demo/shopping-policy-agent.js';
import { loadServerEnvironment } from '../runtime/server-config.js';
import { isMain } from './db-cli.js';

export async function main(args: string[], dependencies: {
  environment?: () => NodeJS.ProcessEnv;
  execute?: typeof runShoppingPolicyDemo;
  log?: (text: string) => void;
} = {}) {
  const { values } = parseArgs({ args, strict: true, options: { policy: { type: 'string' }, question: { type: 'string' }, model: { type: 'string' } } });
  const input = validateDemoInput({ question: values.question ?? '', policy: values.policy ?? '', ...(values.model !== undefined ? { model: values.model } : {}) });
  const env = (dependencies.environment ?? loadServerEnvironment)();
  if (!env.OPENAI_API_KEY?.trim()) throw new AgentDemoError('OPENAI_API_KEY is required for the agent demo.');
  const result = await (dependencies.execute ?? runShoppingPolicyDemo)(input, { apiKey: env.OPENAI_API_KEY });
  (dependencies.log ?? console.log)(JSON.stringify(result, null, 2));
}
if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof AgentDemoError ? error.message : 'Agent demo failed. Check the command arguments and configuration.');
  process.exitCode = 1;
});
