import { z } from "zod";
import type { AgentQuestion } from "../../shared/agent-interactions.js";

const option = z.object({
  label: z.string().min(1).max(1000),
  description: z.string().max(4000).optional(),
});
export const questionsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      header: z.string().max(200),
      question: z.string().min(1).max(10000),
      options: z.array(option).max(30),
      multiSelect: z.boolean(),
      allowOther: z.boolean(),
      isSecret: z.boolean().optional(),
    }),
  )
  .min(1)
  .max(20)
  .refine(
    (questions) =>
      new Set(questions.map((q) => q.id)).size === questions.length,
    "Question ids must be unique",
  );

export function codexQuestions(input: unknown): AgentQuestion[] {
  const rows = z
    .array(
      z.object({
        id: z.string(),
        header: z.string(),
        question: z.string(),
        options: z.array(option).nullish(),
        isOther: z.boolean().optional(),
        isSecret: z.boolean().optional(),
      }),
    )
    .parse(input);
  return questionsSchema.parse(
    rows.map((q) => ({
      ...q,
      options: q.options ?? [],
      multiSelect: false,
      allowOther: q.isOther === true || !q.options?.length,
    })),
  );
}
export function claudeQuestions(input: unknown): AgentQuestion[] {
  const rows = z
    .object({
      questions: z.array(
        z.object({
          header: z.string(),
          question: z.string(),
          options: z.array(option),
          multiSelect: z.boolean().optional(),
        }),
      ),
    })
    .parse(input).questions;
  return questionsSchema.parse(
    rows.map((q, index) => ({
      ...q,
      id: String(index),
      multiSelect: q.multiSelect === true,
      allowOther: true,
    })),
  );
}
export function questionAnswers(
  questions: AgentQuestion[],
  input: unknown,
): Record<string, string[]> {
  const value = z
    .object({
      answers: z.record(
        z.string(),
        z.array(z.string().trim().min(1).max(10000)).min(1).max(30),
      ),
    })
    .parse(input).answers;
  if (
    Object.keys(value).length !== questions.length ||
    questions.some((q) => !Object.hasOwn(value, q.id))
  )
    throw new Error("Ответьте на каждый вопрос");
  const answers: Record<string, string[]> = Object.create(null);
  for (const question of questions) {
    const selected = [...new Set(value[question.id])];
    if (
      (!question.multiSelect && selected.length !== 1) ||
      (!question.allowOther &&
        selected.some(
          (answer) =>
            !question.options.some((option) => option.label === answer),
        ))
    )
      throw new Error("Недопустимый вариант ответа");
    answers[question.id] = selected;
  }
  return answers;
}
