import { Message } from "discord.js";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// v1.14.0 [DISCORD-MULTIPURPOSE]: trigger khi @claude mention HOẶC reply-to-bot.
// Ticket key extract optional (từ content hoặc parent message).
const TICKET_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
// Strip discord <@12345> mentions khỏi content để lấy content_stripped.
const MENTION_STRIP_RE = /<@!?\d+>/g;

const DEFAULT_HELPER = path.join(
  os.homedir(),
  ".claude/plugins/marketplaces/apero-tools/plugins/jira-bug-analyzer/skills/jira-bug-analyzer/assets/discord-inbox-write.sh",
);

function helperPath(): string | null {
  const override = process.env.JIRA_BUG_INBOX_WRITER;
  const candidate = override && override.trim() ? override : DEFAULT_HELPER;
  return fs.existsSync(candidate) ? candidate : null;
}

export interface TryInboxResult {
  handled: boolean;
  reply?: string;
}

interface TriggerCheck {
  triggerType: "mention" | "reply";
  referencedMessage?: Message;
}

/**
 * Determine if message triggers jira-bug-analyzer v1.14 flow.
 * Trigger when:
 *   - Bot is mentioned (@claude), OR
 *   - Message is a reply to a message authored by the bot.
 * Any other message → return null; message.ts caller stays silent (no SDK session).
 */
async function detectTrigger(message: Message): Promise<TriggerCheck | null> {
  const botId = message.client.user?.id;
  if (!botId) return null;

  if (message.mentions.users.has(botId)) {
    if (message.reference?.messageId) {
      const ref = await safeFetchReference(message);
      if (ref?.author.id === botId) {
        return { triggerType: "reply", referencedMessage: ref };
      }
    }
    return { triggerType: "mention" };
  }

  if (message.reference?.messageId) {
    const ref = await safeFetchReference(message);
    if (ref?.author.id === botId) {
      return { triggerType: "reply", referencedMessage: ref };
    }
  }

  return null;
}

async function safeFetchReference(message: Message): Promise<Message | null> {
  try {
    return await message.fetchReference();
  } catch {
    return null;
  }
}

function extractTicket(text: string): string {
  const m = text.match(TICKET_RE);
  return m ? m[1] : "";
}

function stripMentions(content: string): string {
  return content.replace(MENTION_STRIP_RE, "").trim();
}

export async function tryJiraDeferInbox(
  message: Message,
  projectPath: string,
): Promise<TryInboxResult> {
  if (process.env.JIRA_BUG_DISCORD_DEFER !== "1") {
    return { handled: false };
  }

  const trigger = await detectTrigger(message);
  if (!trigger) return { handled: false };

  const helper = helperPath();
  if (!helper) {
    return {
      handled: true,
      reply: `⚠️ Inbox helper không tồn tại tại \`${DEFAULT_HELPER}\`. Set env \`JIRA_BUG_INBOX_WRITER\` để trỏ custom path, hoặc reinstall plugin.`,
    };
  }

  const rawContent = message.content;
  const contentStripped = stripMentions(rawContent);

  // Extract ticket key from own content first; fall back to parent message content on reply.
  let ticket = extractTicket(contentStripped);
  let referencedTicket = "";
  if (trigger.triggerType === "reply" && trigger.referencedMessage) {
    referencedTicket = extractTicket(trigger.referencedMessage.content);
    if (!ticket) {
      ticket = referencedTicket;
    }
  }

  // Thread detection: Discord thread channels have isThread() === true.
  // The thread_id IS the channelId when inside a thread.
  const threadId =
    "isThread" in message.channel && typeof message.channel.isThread === "function" && message.channel.isThread()
      ? message.channelId
      : "";

  const referencedMessageId = message.reference?.messageId ?? "";

  const inboxDir = path.join(projectPath, ".jira-bug", "discord-inbox");
  const attachments = Array.from(message.attachments.values()).map((a) => ({
    filename: a.name,
    url: a.url,
    size: a.size,
  }));

  const args = [
    helper,
    "--trigger-type", trigger.triggerType,
    "--message-id", message.id,
    "--channel-id", message.channelId,
    "--guild-id", message.guildId ?? "",
    "--author-id", message.author.id,
    "--author-name", message.author.username,
    "--content", rawContent,
    "--content-stripped", contentStripped,
    "--attachments", JSON.stringify(attachments),
    "--inbox-dir", inboxDir,
    "--thread-id", threadId,
    "--referenced-message-id", referencedMessageId,
    "--referenced-ticket", referencedTicket,
  ];

  // Pass ticket flag only when present (v1.14 script treats --ticket as optional).
  if (ticket) {
    args.push("--ticket", ticket);
  }

  const result = await runHelper("bash", args);

  // Build reply tag describing what classifier will see.
  const triggerTag = trigger.triggerType === "mention" ? "@claude mention" : "reply-to-bot";
  const ticketTag = ticket ? `**${ticket}**` : "(không có ticket key, classifier sẽ phân loại intent)";

  if (result.code === 0) {
    return {
      handled: true,
      reply: `✅ Đã nhận ${triggerTag} ${ticketTag}. Terminal \`--manager\` sẽ phân loại intent + act (ETA <10s).`,
    };
  }
  if (result.code === 10) {
    return {
      handled: true,
      reply: `ℹ️ Message đã được forward trước đó (duplicate message_id). --manager đang xử lý.`,
    };
  }

  return {
    handled: true,
    reply: `⚠️ Inbox write fail (exit ${result.code}): \`${result.stderr.slice(0, 300)}\`. Dán nội dung này vào terminal \`--manager\` để resume thủ công.`,
  };
}

interface HelperResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runHelper(cmd: string, args: string[]): Promise<HelperResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (buf) => { stdout += buf.toString(); });
    proc.stderr.on("data", (buf) => { stderr += buf.toString(); });
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}
