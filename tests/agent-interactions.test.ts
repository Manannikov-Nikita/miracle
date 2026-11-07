import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import {
  AgentManager,
  type AgentToolServices,
} from "../src/server/agents/manager";
import { startAgentTurn } from "../src/server/agents/adapter";

vi.mock("../src/server/agents/adapter", () => ({ startAgentTurn: vi.fn() }));
let root: string,
  db: Database,
  store: ProjectStore,
  manager: AgentManager,
  chatId: string;
let finish: () => void;
let sent: any[];
let answers: any[];
let emit: (event: any) => void;
let steer: (input: any) => Promise<void>;
const input = (content = "Continue") => ({
  content,
  clientRequestId: randomUUID(),
});
const question = {
  id: "q",
  header: "Output",
  question: "Which output?",
  options: [{ label: "Table" }, { label: "Chart" }],
  multiSelect: false,
  allowOther: true,
};
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-interactions-")));
  vi.stubEnv("MIRACLE_INSTALL_ROOT", join(root, "install"));
  const dataDir = join(root, ".miracle");
  db = new Database(dataDir);
  migrate(db, () => {});
  store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
    projectRoot: root,
    dataDir,
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
  });
  manager = new AgentManager(
    store,
    new WorkspaceOperations(store, async () => {}),
    {} as AgentToolServices,
    () => "http://127.0.0.1:3001",
  );
  const profile = store.saveProfile({
    name: "Fixture",
    provider: "codex",
    command: "codex",
  });
  chatId = store.createChat({ profileId: profile.id, autoApprove: true }).id;
  sent = [];
  answers = [];
  steer = async (value) => {
    sent.push(value);
  };
  vi.mocked(startAgentTurn).mockImplementation((options) => {
    emit = options.onEvent;
    return {
      completion: new Promise<any>((resolve) => {
        finish = () => resolve({});
      }),
      cancel: async () => finish(),
      respond: () => {},
      answerQuestion: (id: string, value: unknown) => {
        answers.push({ id, value });
      },
      steer: (value: any) => steer(value),
    };
  });
});
afterEach(async () => {
  await manager.close();
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function start() {
  const turn = manager.start(chatId, input());
  await Promise.resolve();
  return turn;
}
const pendingQuestion = () =>
  store.conversation(chatId).messages.find((m) => m.role === "question")!;

it("waits for an actual question answer even with auto approval and deduplicates answer retries", async () => {
  const turn = await start();
  emit({ type: "question", id: "native-q", questions: [question] });
  expect(store.turn(turn.id).status).toBe("waiting");
  const q = pendingQuestion();
  expect(q.details?.question.status).toBe("pending");
  const id = q.details!.question.id;
  const result = manager.answerQuestion(id, { answers: { q: ["Chart"] } });
  expect(result.details?.question.status).toBe("answered");
  expect(manager.answerQuestion(id, { answers: { q: ["Chart"] } }).id).toBe(
    q.id,
  );
  expect(answers).toEqual([{ id: "native-q", value: { q: ["Chart"] } }]);
  expect(() =>
    manager.answerQuestion(id, { answers: { q: ["Table"] } }),
  ).toThrow();
  expect(store.turn(turn.id).status).toBe("running");
});
it("cancels questions on turn completion and rejects late answers", async () => {
  await start();
  emit({ type: "question", id: "native-q", questions: [question] });
  const id = pendingQuestion().details!.question.id;
  const done = manager.active!.completion;
  finish();
  await done;
  expect(pendingQuestion().details?.question.status).toBe("cancelled");
  expect(() =>
    manager.answerQuestion(id, { answers: { q: ["Chart"] } }),
  ).toThrow();
});
it("routes Claude AskUserQuestion through a question callback rather than automatic approval", async () => {
  await start();
  const original = {
    questions: [
      {
        question: "Which output?",
        header: "Output",
        options: [
          { label: "Table", description: "Rows" },
          { label: "Chart", description: "Bars" },
        ],
        multiSelect: true,
      },
    ],
  };
  const promise = manager.requestPermission(manager.active!, {
    tool_name: "AskUserQuestion",
    input: original,
  });
  const q = pendingQuestion().details!.question;
  expect(q.status).toBe("pending");
  manager.answerQuestion(q.id, {
    answers: { [q.questions[0].id]: ["Table", "Chart"] },
  });
  await expect(promise).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...original, answers: { "Which output?": "Table, Chart" } },
  });
});
it("steers the existing process once and persists input in transcript order", async () => {
  const turn = await start();
  emit({ type: "message", text: "Before" });
  const next = input("Use a table");
  await Promise.all([
    manager.steer(turn.id, next),
    manager.steer(turn.id, next),
  ]);
  emit({ type: "message", text: "After" });
  const done = manager.active!.completion;
  finish();
  await done;
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toContain("Use a table");
  expect(
    store
      .conversation(chatId)
      .messages.filter((m) => ["assistant", "user"].includes(m.role))
      .map((m) => m.content),
  ).toEqual(["Continue", "Before", "Use a table", "After"]);
  await expect(manager.steer(turn.id, next)).resolves.toMatchObject({
    id: turn.id,
    status: "completed",
  });
  expect(sent).toHaveLength(1);
  await expect(
    manager.steer(turn.id, { ...next, content: "Changed" }),
  ).rejects.toThrow();
});
it("waits for an accepted steer receipt before completing the turn", async () => {
  const turn = await start();
  let accept!: () => void;
  steer = async (value) => {
    sent.push(value);
    await new Promise<void>((resolve) => {
      accept = resolve;
    });
  };
  const pending = manager.steer(turn.id, input("Keep going"));
  const done = manager.active!.completion;
  finish();
  await Promise.resolve();
  expect(manager.active).toBeDefined();
  accept();
  await pending;
  await done;
  expect(store.turn(turn.id).status).toBe("completed");
  expect(
    store.conversation(chatId).messages.at(-1)?.details?.steer.status,
  ).toBe("accepted");
});
it("rejects steering a completed or foreign turn without launching work", async () => {
  const turn = await start();
  const done = manager.active!.completion;
  finish();
  await done;
  await expect(manager.steer(turn.id, input("Late"))).rejects.toMatchObject({
    code: "AGENT_TURN_ENDED",
  });
  expect(sent).toHaveLength(0);
});
it("retries a definitely unsent steer with the same request id without duplicating the user message", async () => {
  const turn = await start();
  const next = input("Retry this");
  steer = async () => {
    throw Object.assign(new Error("Starting"), { code: "AGENT_NOT_READY" });
  };
  await expect(manager.steer(turn.id, next)).rejects.toMatchObject({
    code: "AGENT_NOT_READY",
  });
  steer = async (value) => {
    sent.push(value);
  };
  await expect(manager.steer(turn.id, next)).resolves.toMatchObject({
    id: turn.id,
  });
  expect(sent).toHaveLength(1);
  expect(
    store
      .conversation(chatId)
      .messages.filter((m) => m.content === "Retry this"),
  ).toHaveLength(1);
});
it("does not retry ambiguous delivery and retains the failed receipt", async () => {
  const turn = await start();
  const next = input("May have arrived");
  steer = async (value) => {
    sent.push(value);
    throw new Error("Connection closed after write");
  };
  await expect(manager.steer(turn.id, next)).rejects.toThrow();
  await expect(manager.steer(turn.id, next)).rejects.toThrow();
  expect(sent).toHaveLength(1);
  expect(
    store.conversation(chatId).messages.at(-1)?.details?.steer.status,
  ).toBe("failed");
});
it("keeps a question waiting when automatic approval resolves another request", async () => {
  const turn = await start();
  manager.updateChat(chatId, { autoApprove: false });
  emit({ type: "question", id: "native-q", questions: [question] });
  const permission = manager.requestPermission(manager.active!, {
    tool_name: "Bash",
    input: { command: "pwd" },
  });
  manager.updateChat(chatId, { autoApprove: true });
  await permission;
  expect(store.turn(turn.id).status).toBe("waiting");
  expect(pendingQuestion().details!.question.status).toBe("pending");
});
it("marks persisted pending questions cancelled after server restart", async () => {
  const turn = await start();
  const done = manager.active!.completion;
  finish();
  await done;
  store.message(chatId, turn.id, "question", question.question, {
    question: { id: randomUUID(), status: "pending", questions: [question] },
  });
  const restarted = new AgentManager(
    store,
    new WorkspaceOperations(store, async () => {}),
    {} as AgentToolServices,
    () => "http://127.0.0.1",
  );
  expect(pendingQuestion().details!.question.status).toBe("cancelled");
  await restarted.close();
});
it("does not replay a rejected steer when an unavailable native session falls back to history", async () => {
  const turn = await start();
  emit({ type: "session", sessionId: "saved-native" });
  steer = async () => {
    throw Object.assign(new Error("Unavailable"), {
      code: "AGENT_STEER_UNSUPPORTED",
    });
  };
  await expect(
    manager.steer(turn.id, input("Never delivered instruction")),
  ).rejects.toThrow();
  const done = manager.active!.completion;
  finish();
  await done;
  const prompts: string[] = [];
  vi.mocked(startAgentTurn).mockImplementationOnce(() => ({
    completion: Promise.reject(
      Object.assign(new Error("Missing"), {
        code: "AGENT_SESSION_UNAVAILABLE",
      }),
    ),
    cancel: async () => {},
    respond: () => {},
  }));
  vi.mocked(startAgentTurn).mockImplementationOnce((options) => {
    prompts.push(options.prompt);
    return {
      completion: Promise.resolve({}),
      cancel: async () => {},
      respond: () => {},
    };
  });
  manager.start(chatId, input("Next normal request"));
  await manager.active!.completion;
  expect(prompts[0]).toContain("Continue");
  expect(prompts[0]).not.toContain("Never delivered instruction");
});
it("restores answered choices but never secret answers into replacement-session history", async () => {
  await start();
  emit({ type: "session", sessionId: "saved-native" });
  emit({
    type: "question",
    id: "native-q",
    questions: [
      question,
      { ...question, id: "secret", question: "Private value?", isSecret: true },
    ],
  });
  manager.answerQuestion(pendingQuestion().details!.question.id, {
    answers: { q: ["Chart"], secret: ["do-not-replay-secret"] },
  });
  const done = manager.active!.completion;
  finish();
  await done;
  const prompts: string[] = [];
  vi.mocked(startAgentTurn).mockImplementationOnce(() => ({
    completion: Promise.reject(
      Object.assign(new Error("Missing"), {
        code: "AGENT_SESSION_UNAVAILABLE",
      }),
    ),
    cancel: async () => {},
    respond: () => {},
  }));
  vi.mocked(startAgentTurn).mockImplementationOnce((options) => {
    prompts.push(options.prompt);
    return {
      completion: Promise.resolve({}),
      cancel: async () => {},
      respond: () => {},
    };
  });
  manager.start(chatId, input("Continue from answers"));
  await manager.active!.completion;
  expect(prompts[0]).toContain("Which output?");
  expect(prompts[0]).toContain("Chart");
  expect(prompts[0]).not.toContain("do-not-replay-secret");
  expect(JSON.stringify(store.conversation(chatId))).not.toContain(
    "do-not-replay-secret",
  );
});
it("does not reinterpret a steering request id as a new turn", async () => {
  const turn = await start();
  const next = input("Steering only");
  await manager.steer(turn.id, next);
  const done = manager.active!.completion;
  finish();
  await done;
  expect(() => manager.start(chatId, next)).toThrow();
});
it("does not persist an answer that the native question channel rejected as expired", async () => {
  await start();
  emit({ type: "question", id: "native-q", questions: [question] });
  manager.active!.process!.answerQuestion = () => {
    throw Object.assign(new Error("Ended"), {
      code: "AGENT_QUESTION_INACTIVE",
    });
  };
  expect(() =>
    manager.answerQuestion(pendingQuestion().details!.question.id, {
      answers: { q: ["Chart"] },
    }),
  ).toThrow();
  expect(pendingQuestion().details!.question.status).not.toBe("answered");
  manager.active!.process!.answerQuestion = () => {};
});
it("marks a sending receipt unconfirmed after a server restart", async () => {
  const turn = await start();
  const done = manager.active!.completion;
  finish();
  await done;
  store.message(chatId, turn.id, "user", "Pending input", {
    steer: { requestId: randomUUID(), status: "sending", identity: "fixture" },
  });
  const restarted = new AgentManager(
    store,
    new WorkspaceOperations(store, async () => {}),
    {} as AgentToolServices,
    () => "http://127.0.0.1",
  );
  expect(
    store.conversation(chatId).messages.at(-1)?.details?.steer,
  ).toMatchObject({
    status: "failed",
    code: "AGENT_STEER_UNCONFIRMED",
    retryable: false,
  });
  await restarted.close();
});
