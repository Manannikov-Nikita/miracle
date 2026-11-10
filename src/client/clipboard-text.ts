/** Initiate the write during the click, before asynchronous data loading can
 * consume browser user activation. ClipboardItem owns the delayed text data. */
export async function writeClipboardText(
  text: string | Promise<string>,
): Promise<void> {
  const clipboard = navigator.clipboard;
  if (
    typeof ClipboardItem === "function" &&
    typeof clipboard?.write === "function"
  ) {
    const content = Promise.resolve(text).then(
      (value) => new Blob([value], { type: "text/plain" }),
    );
    // Constructors/write may fail before the browser starts consuming content.
    // Keep a later failed/aborted snapshot from becoming an unhandled rejection.
    void content.catch(() => {});
    await Promise.all([
      clipboard.write([new ClipboardItem({ "text/plain": content })]),
      content,
    ]);
    return;
  }
  const value = await text;
  await clipboard.writeText(value);
}
