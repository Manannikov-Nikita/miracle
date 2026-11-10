import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeClipboardText } from "../src/client/clipboard-text";

class ClipboardItemFixture {
  constructor(private readonly data: Record<string, Promise<Blob>>) {}
  getType(type: string) {
    return this.data[type];
  }
}
let copied: string | undefined;
const writeText = vi.fn();
const write = vi.fn(async (items: ClipboardItemFixture[]) => {
  const blob = await items[0].getType("text/plain");
  expect(blob.type).toBe("text/plain");
  copied = await blob.text();
});
beforeEach(() => {
  copied = undefined;
  write.mockClear();
  writeText.mockReset();
  vi.stubGlobal("ClipboardItem", ClipboardItemFixture);
  vi.stubGlobal("navigator", { clipboard: { write, writeText } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("starts clipboard writing during the gesture before deferred table text resolves", async () => {
  const text = Promise.withResolvers<string>();
  const operation = writeClipboardText(text.promise);
  expect(write).toHaveBeenCalledOnce();
  expect(writeText).not.toHaveBeenCalled();
  expect(copied).toBeUndefined();
  text.resolve("| Name |\n| --- |\n| Last row | ");
  await operation;
  expect(copied).toBe("| Name |\n| --- |\n| Last row | ");
});

it.each(["write", "ClipboardItem"])(
  "uses writeText only when %s support is unavailable",
  async (missing) => {
    if (missing === "write")
      vi.stubGlobal("navigator", { clipboard: { writeText } });
    else vi.stubGlobal("ClipboardItem", undefined);
    const text = Promise.withResolvers<string>();
    const operation = writeClipboardText(text.promise);
    expect(writeText).not.toHaveBeenCalled();
    text.resolve("complete table");
    await operation;
    expect(writeText).toHaveBeenCalledExactlyOnceWith("complete table");
    expect(write).not.toHaveBeenCalled();
  },
);

it("propagates a failed snapshot without copying substitute text", async () => {
  const failed = new Error("snapshot unavailable");
  await expect(writeClipboardText(Promise.reject(failed))).rejects.toBe(failed);
  expect(copied).toBeUndefined();
  expect(writeText).not.toHaveBeenCalled();
});

it("preserves clipboard denial without fallback and handles later snapshot rejection", async () => {
  const denied = new DOMException("Denied", "NotAllowedError");
  write.mockRejectedValueOnce(denied);
  const text = Promise.withResolvers<string>();
  const operation = writeClipboardText(text.promise);
  await expect(operation).rejects.toBe(denied);
  text.reject(new Error("snapshot aborted after denial"));
  // Let unhandled-rejection reporting run: no secondary failure may escape.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(writeText).not.toHaveBeenCalled();
});

it("handles a synchronous clipboard failure and a later snapshot rejection", async () => {
  const denied = new Error("clipboard constructor unavailable");
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor() {
        throw denied;
      }
    },
  );
  const text = Promise.withResolvers<string>();
  await expect(writeClipboardText(text.promise)).rejects.toBe(denied);
  text.reject(new Error("snapshot aborted after failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(writeText).not.toHaveBeenCalled();
});
