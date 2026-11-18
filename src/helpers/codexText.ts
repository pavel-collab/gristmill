import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const cachedModel = z.object({
  slug: z.string().min(1),
  display_name: z.string().optional(),
  visibility: z.string(),
});

export async function listCodexModels() {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const raw = await readFile(join(home, "models_cache.json"), "utf8");
  const cache = z.object({ models: z.array(z.unknown()) }).parse(JSON.parse(raw));

  return cache.models.flatMap((entry) => {
    const parsed = cachedModel.safeParse(entry);

    if (!parsed.success || parsed.data.visibility !== "list") return [];

    return [{ id: parsed.data.slug, name: parsed.data.display_name || parsed.data.slug }];
  });
}

export const codexChatPrompt = z
  .array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.union([
        z.string(),
        z
          .array(z.object({ type: z.literal("text"), text: z.string() }))
          .transform((parts) => parts.map((part) => part.text).join("\n")),
      ]),
    })
  )
  .nonempty();

export async function startCodexTextSession(model: string, instructions: string) {
  const { Codex } = await import("@openai/codex-sdk");
  const packaged = __dirname.includes("/app.asar/");

  const codex = new Codex({
    ...(packaged
      ? {
          codexPathOverride: join(
            process.resourcesPath,
            "app.asar.unpacked",
            "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
          ),
        }
      : {}),
    config: {
      forced_login_method: "chatgpt",
      model_provider: "openai",
      developer_instructions: instructions,
      features: {
        shell_tool: false,
        apps: false,
        plugins: false,
        hooks: false,
        multi_agent: false,
      },
    },
    configOverrides: ["mcp_servers={}"],
  });

  const thread = codex.startThread({
    model: model === "codex-default" ? undefined : model,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    webSearchMode: "disabled",
    workingDirectory: tmpdir(),
    skipGitRepoCheck: true,
    networkAccessEnabled: false,
  });

  return async (prompt: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const result = await thread.run(prompt, { signal });

    if (!result.finalResponse.trim()) throw new Error("Codex returned an empty response");

    return result.finalResponse;
  };
}

export async function runCodexChat(
  model: string,
  messages: z.output<typeof codexChatPrompt>,
  signal: AbortSignal
) {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");

  const run = await startCodexTextSession(model, instructions);

  return run(JSON.stringify(messages.filter((message) => message.role !== "system")), signal);
}
