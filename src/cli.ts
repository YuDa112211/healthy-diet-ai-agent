import { AI_API_URL } from './server/supabaseRuntime';
import { runAgentStream } from './server/agentRuntime';
import { getStorage } from './storage/runtime';
import type { ChatModelSource } from './server/chatPayload';

type CliArgs = {
  message: string;
  userId: string;
  threadId: string;
  modelSource: ChatModelSource;
};

type CliTurnResult = {
  finalText: string;
};

const DEFAULT_CLI_USER_ID = process.env.CLI_USER_ID || 'local-user';
const DEFAULT_CLI_THREAD_ID = process.env.CLI_THREAD_ID || 'local-thread';

export const parseCliArgs = (argv: string[]): CliArgs => {
  let message = '';
  let userId = DEFAULT_CLI_USER_ID;
  let threadId = DEFAULT_CLI_THREAD_ID;
  let modelSource: ChatModelSource = 'auto';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1] || '';
    if (token === '--message' && next) {
      message = next;
      index += 1;
    } else if (token === '--user-id' && next) {
      userId = next;
      index += 1;
    } else if (token === '--thread-id' && next) {
      threadId = next;
      index += 1;
    } else if (token === '--model-source' && (next === 'auto' || next === 'local' || next === 'google')) {
      modelSource = next;
      index += 1;
    }
  }

  if (!message.trim()) {
    throw new Error('CLI requires --message "<text>"');
  }

  return {
    message: message.trim(),
    userId,
    threadId,
    modelSource,
  };
};

export const runCliTurn = async (args: CliArgs): Promise<CliTurnResult> => {
  const storage = await getStorage();
  await storage.ensureReady();

  await storage.upsertChatRoom({
    threadId: args.threadId,
    userId: args.userId,
    title: args.message.slice(0, 60),
  });

  const inserted = await storage.insertChatHistory({
    roomId: args.threadId,
    userId: args.userId,
    userMessage: args.message,
    title: args.message.slice(0, 60),
    aiAnalysisReport: '__PENDING__',
    recordType: 'chat',
  });

  const writes: string[] = [];
  const response = await runAgentStream(
    {
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as never,
    { configurable: { thread_id: args.threadId } },
    {
      messages: [{ role: 'user', content: args.message }],
      user_id: args.userId,
      room_id: args.threadId,
      user_profile_context: 'CLI session',
      image_path: '',
      model_source: args.modelSource,
    }
  );

  if (inserted.id) {
    await storage.updateChatHistoryReply({
      chatHistoryId: inserted.id,
      aiReply: response.finalText,
    });
  }

  return {
    finalText: response.finalText,
  };
};

export const runCliForTest = async (
  argv: string[],
  executor?: (args: CliArgs) => Promise<CliTurnResult>
): Promise<string> => {
  const args = parseCliArgs(argv);
  const result = executor ? await executor(args) : await runCliTurn(args);
  return `${result.finalText}\n`;
};

const main = async () => {
  const output = await runCliForTest(process.argv.slice(2));
  process.stdout.write(output);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error('CLI execution failed:', error);
    console.error(`LLM base URL: ${AI_API_URL}`);
    process.exit(1);
  });
}
