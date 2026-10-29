import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { PendingQuestion, QuestionAnswer } from "../worker/types.ts";

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

export function parseQuestionButton(customId: string): QuestionAnswer | null {
  if (!customId.startsWith(PREFIX)) return null;
  const value = customId.slice(PREFIX.length);
  const separator = value.lastIndexOf(":");
  if (separator < 1 || !/^\d+$/.test(value.slice(separator + 1))) return null;
  return {
    questionId: value.slice(0, separator),
    optionIndex: Number(value.slice(separator + 1)),
  };
}
