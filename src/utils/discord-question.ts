import { splitIntoDiscordChunks } from "./discord-message.ts";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { ButtonAnswer, PendingQuestion } from "../worker/types.ts";

const PREFIX = "codex-answer:";

function buttonLabel(text: string): string {
  let label = "";
  for (const char of text) {
    if (label.length + char.length > 80) break;
    label += char;
  }
  return label;
}

export function buildQuestionButtons(
  question: PendingQuestion,
  disabled = false,
) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  // Legacy Discord messages allow five rows with five buttons each. All
  // options remain in the message text and can also be answered by text.
  for (
    let start = 0;
    start < Math.min(question.options.length, 25);
    start += 5
  ) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      question.options.slice(start, Math.min(start + 5, 25)).map((
        option,
        offset,
      ) =>
        new ButtonBuilder()
          .setCustomId(`${PREFIX}${question.id}:${start + offset}`)
          .setLabel(buttonLabel(`${start + offset + 1}. ${option}`))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      ),
    ));
  }
  return rows;
}

export function parseQuestionButton(customId: string): ButtonAnswer | null {
  if (!customId.startsWith(PREFIX)) return null;
  const value = customId.slice(PREFIX.length);
  const separator = value.lastIndexOf(":");
  if (separator < 1 || !/^\d+$/.test(value.slice(separator + 1))) return null;
  return {
    questionId: value.slice(0, separator),
    optionIndex: Number(value.slice(separator + 1)),
  };
}

type QuestionMessage = { question: PendingQuestion; message: { id: string } };

// Resolve against the messages visible at receipt, before any Discord or file I/O.
export async function captureDiscordAnswer(
  message: {
    id: string;
    content: string;
    reference: { messageId?: string } | null;
    fetchReference(): Promise<{ author: { id: string }; content: string }>;
  },
  messages: Iterable<QuestionMessage>,
  botId: string | undefined,
) {
  const shown = [...messages];
  const reference = message.reference?.messageId;
  let target = reference &&
    shown.find((entry) => entry.message.id === reference);
  if (reference && !target) {
    const replyTo = await message.fetchReference().catch(() => undefined);
    if (
      !replyTo ||
      (replyTo.author.id === botId && replyTo.content.startsWith("❓"))
    ) {
      return "expired" as const;
    }
  }
  target ||= shown.find((entry) =>
    BigInt(entry.message.id) < BigInt(message.id)
  );
  return target
    ? { questionId: target.question.id, text: message.content }
    : undefined;
}

export function questionStatusMessages(questions: readonly PendingQuestion[]) {
  return questions.flatMap((question) => {
    const text = [
      `❓ ${question.title}`,
      ...question.options.map((option, i) => `${i + 1}. ${option}`),
      ...(question.options.length
        ? []
        : ["元の質問に自由文で返信してください。"]),
    ].join("\n");
    const parts = splitIntoDiscordChunks(text);
    return parts.map((content, i) => ({
      content,
      components: i === parts.length - 1 ? buildQuestionButtons(question) : [],
    }));
  });
}
