import type { AgentImageMimeType } from "../shared/agents.js";

// Check the declared media type against the actual container and its boundaries.
// Images remain opaque bytes; no SVG/HTML, remote URLs or local paths are accepted.
export function validImage(bytes: Buffer, mime: AgentImageMimeType): boolean {
  if (mime === "image/png") {
    if (
      bytes.length < 57 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    )
      return false;
    let offset = 8,
      data = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset),
        type = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) return false;
      if (
        offset === 8 &&
        (type !== "IHDR" ||
          length !== 13 ||
          !bytes.readUInt32BE(16) ||
          !bytes.readUInt32BE(20))
      )
        return false;
      if (type === "IDAT") data = true;
      offset += length + 12;
      if (type === "IEND")
        return data && length === 0 && offset === bytes.length;
    }
    return false;
  }
  if (mime === "image/jpeg") {
    if (
      bytes.length < 12 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes.at(-2) !== 0xff ||
      bytes.at(-1) !== 0xd9
    )
      return false;
    let offset = 2,
      frame = false;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) return false;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length) return false;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return false;
      if (marker === 0xda)
        return frame && length >= 6 && offset + length < bytes.length - 2;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (
          length < 8 ||
          !bytes.readUInt16BE(offset + 3) ||
          !bytes.readUInt16BE(offset + 5)
        )
          return false;
        frame = true;
      }
      offset += length;
    }
    return false;
  }
  if (mime === "image/gif")
    return (
      bytes.length >= 20 &&
      ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) &&
      bytes.readUInt16LE(6) > 0 &&
      bytes.readUInt16LE(8) > 0 &&
      bytes.includes(0x2c, 13) &&
      bytes.at(-1) === 0x3b
    );
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return false;
  let offset = 12,
    frame = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4);
    if (!size || offset + 8 + size > bytes.length) return false;
    if (["VP8 ", "VP8L", "ANMF"].includes(type)) frame = true;
    offset += 8 + size + (size % 2);
  }
  return frame && offset === bytes.length;
}
