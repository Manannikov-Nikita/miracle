import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import {
  AgentManager,
  type AgentToolServices,
} from "../src/server/agents/manager";
import { registerAgentRoutes } from "../src/server/agents/routes";
import { startAgentTurn } from "../src/server/agents/adapter";

vi.mock("../src/server/agents/adapter", () => ({
  startAgentTurn: vi.fn(() => ({
    completion: Promise.resolve(),
    cancel: async () => {},
    respond: () => {},
  })),
}));
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const image = {
  name: "chart.png",
  mimeType: "image/png",
  dataUrl: `data:image/png;base64,${png}`,
};
function pngWithNote(note: string) {
  const source = Buffer.from(png, "base64");
  const text = Buffer.from(`Note\0${note}`);
  const chunk = Buffer.alloc(text.length + 12);
  chunk.writeUInt32BE(text.length);
  chunk.write("tEXt", 4);
  text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([
    source.subarray(0, -12),
    chunk,
    source.subarray(-12),
  ]).toString("base64");
}
let root: string,
  db: Database,
  store: ProjectStore,
  manager: AgentManager,
  chatId: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-agent-images-")));
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
    name: "Images",
    provider: "codex",
    command: "codex",
  });
  chatId = store.createChat({ profileId: profile.id }).id;
  vi.mocked(startAgentTurn).mockClear();
});
afterEach(async () => {
  await manager.close();
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const payload = (content = "") => ({
  content,
  clientRequestId: randomUUID(),
  images: [image],
});

it("persists an image-only message as metadata and delivers the image bytes to the provider", async () => {
  const turn = manager.start(chatId, payload());
  await manager.active!.completion;
  const conversation = store.conversation(chatId);
  const attachment = (conversation.messages[0].details?.images as any[])[0];
  expect(attachment).toMatchObject({
    name: "chart.png",
    mimeType: "image/png",
    size: 69,
    url: `/api/chats/${chatId}/images/${attachment.id}`,
  });
  expect(conversation.chat.title).toBe("chart.png");
  expect(JSON.stringify(conversation)).not.toContain(png);
  expect(JSON.stringify(store.since(0))).not.toContain(png);
  expect(vi.mocked(startAgentTurn).mock.calls[0][0]).toMatchObject({
    images: [{ name: "chart.png", mimeType: "image/png", data: png }],
  });
  expect(store.turn(turn.id).status).toBe("completed");
  expect(
    Buffer.from(db.query("SELECT bytes FROM agent_images").rows[0].bytes),
  ).toEqual(Buffer.from(png, "base64"));
});

it("deduplicates an identical image retry and rejects changed image identity", async () => {
  const input = payload("look");
  const turn = manager.start(chatId, input);
  await manager.active!.completion;
  expect(manager.start(chatId, input).id).toBe(turn.id);
  expect(() =>
    manager.start(chatId, {
      ...input,
      images: [{ ...image, name: "different.png" }],
    }),
  ).toThrow(/Идентификатор/);
  expect(() => manager.start(chatId, { ...input, images: [] })).toThrow(
    /Идентификатор/,
  );
  expect(db.query("SELECT id FROM agent_images").rows).toHaveLength(1);
});

it.each([
  ["too many", Array(5).fill(image)],
  ["MIME mismatch", [{ ...image, mimeType: "image/jpeg" }]],
  [
    "wrong bytes",
    [{ ...image, dataUrl: "data:image/png;base64,PHN2Zz48L3N2Zz4=" }],
  ],
  [
    "truncated",
    [
      {
        ...image,
        dataUrl: `data:image/png;base64,${Buffer.from(png, "base64").subarray(0, 30).toString("base64")}`,
      },
    ],
  ],
  ["remote URL", [{ ...image, dataUrl: "https://example.com/private.png" }]],
  [
    "arbitrary file",
    [{ name: "x", mimeType: "image/png", path: "/etc/passwd" }],
  ],
  [
    "oversize",
    [
      {
        ...image,
        dataUrl: `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64")}`,
      },
    ],
  ],
])("rejects %s images before saving a turn", (_label, images) => {
  expect(() => manager.start(chatId, { ...payload("look"), images })).toThrow();
  expect(store.conversation(chatId).messages).toHaveLength(0);
});

it("rejects a truncated JPEG marker as an invalid image", () => {
  const data = Buffer.from([
    0xff,
    0xd8,
    ...Array(20).fill(0xff),
    0xd9,
  ]).toString("base64");
  try {
    manager.start(chatId, {
      ...payload("look"),
      images: [
        {
          name: "broken.jpg",
          mimeType: "image/jpeg",
          dataUrl: `data:image/jpeg;base64,${data}`,
        },
      ],
    });
    expect.fail("Malformed JPEG accepted");
  } catch (error) {
    expect(error).toMatchObject({
      statusCode: 400,
      code: "INVALID_AGENT_IMAGE",
    });
  }
});

it.each(["AGENT_SESSION_UNAVAILABLE", "AGENT_SESSION_TOO_LARGE"])(
  "replays previous image attachments for %s",
  async (code) => {
    manager.start(chatId, payload());
    await manager.active!.completion;
    db.query("UPDATE agent_chats SET native_session_id='expired' WHERE id=?1", [
      chatId,
    ]);
    vi.mocked(startAgentTurn).mockImplementationOnce(() => ({
      completion: Promise.reject(
        Object.assign(new Error("missing"), {
          code,
        }),
      ),
      cancel: async () => {},
      respond: () => {},
    }));
    manager.start(chatId, {
      content: "Now describe it",
      clientRequestId: randomUUID(),
    });
    await manager.active!.completion;
    const replay = vi.mocked(startAgentTurn).mock.calls.at(-1)![0];
    expect(replay.images).toMatchObject([
      { name: expect.stringContaining("chart.png"), data: png },
    ]);
    expect(replay.prompt).toContain("chart.png");
  },
);

it("serves persisted images through authenticated chat-scoped URLs", async () => {
  manager.start(chatId, payload());
  await manager.active!.completion;
  const attachment = (
    store.conversation(chatId).messages[0].details?.images as any[]
  )[0];
  const app = Fastify();
  registerAgentRoutes(app, manager, (request) => {
    if (request.headers.authorization !== "local")
      throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  });
  try {
    expect((await app.inject({ url: attachment.url })).statusCode).toBe(401);
    const response = await app.inject({
      url: attachment.url,
      headers: { authorization: "local" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload).toEqual(Buffer.from(png, "base64"));
    const other = store.createChat({ profileId: store.chat(chatId).profileId });
    expect(
      (
        await app.inject({
          url: attachment.url.replace(chatId, other.id),
          headers: { authorization: "local" },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});

it("accepts large image bodies only on the message route", async () => {
  const data = pngWithNote("x".repeat(2 * 1024 * 1024));
  const app = Fastify({ bodyLimit: 1024 });
  registerAgentRoutes(app, manager, () => {});
  app.post("/small", async () => ({ ok: true }));
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      payload: {
        ...payload(),
        images: [{ ...image, dataUrl: `data:image/png;base64,${data}` }],
      },
    });
    expect(response.statusCode).toBe(202);
    await manager.active?.completion;
    expect(
      (store.conversation(chatId).messages[0].details?.images as any[])[0].size,
    ).toBeGreaterThan(2 * 1024 * 1024);
    expect(
      (await app.inject({ method: "POST", url: "/small", payload: { data } }))
        .statusCode,
    ).toBe(413);
  } finally {
    await app.close();
  }
});

it("reports omitted older images when rebuilding a long native session", async () => {
  for (let i = 0; i < 21; i++) {
    manager.start(chatId, {
      ...payload("history"),
      images: [
        {
          ...image,
          name: `${i}.png`,
          dataUrl: `data:image/png;base64,${pngWithNote(String(i))}`,
        },
      ],
    });
    await manager.active!.completion;
  }
  db.query("UPDATE agent_chats SET native_session_id='expired' WHERE id=?1", [
    chatId,
  ]);
  vi.mocked(startAgentTurn).mockImplementationOnce(() => ({
    completion: Promise.reject(
      Object.assign(new Error("missing"), {
        code: "AGENT_SESSION_UNAVAILABLE",
      }),
    ),
    cancel: async () => {},
    respond: () => {},
  }));
  manager.start(chatId, { content: "Continue", clientRequestId: randomUUID() });
  await manager.active!.completion;
  const images = vi.mocked(startAgentTurn).mock.calls.at(-1)![0].images!;
  expect(images).toHaveLength(20);
  expect(images[0].name).toContain(": 1.png");
  expect(images.at(-1)?.name).toContain(": 20.png");
  expect(
    store
      .conversation(chatId)
      .messages.some(
        (message) =>
          message.role === "system" &&
          message.content.includes("1 старых изображений не переданы"),
      ),
  ).toBe(true);
});

it.each([
  ["image/gif", "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="],
  ["image/webp", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"],
])("preserves %s image bytes", async (mimeType, data) => {
  manager.start(chatId, {
    ...payload(),
    images: [
      {
        name: "reference",
        mimeType,
        dataUrl: `data:${mimeType};base64,${data}`,
      },
    ],
  });
  await manager.active!.completion;
  expect(vi.mocked(startAgentTurn).mock.calls[0][0].images).toMatchObject([
    { mimeType, data },
  ]);
});
