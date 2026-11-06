/** Content ink follows the slide background; saved series colors stay intact. */
export function presentationColors(background: string) {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(background.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179
    ? {
        text: "#20252b",
        muted: "#475569",
        grid: "#cbd5e1",
        raised: "#00000008",
        accent: "#315aaa",
      }
    : {
        text: "#eeeff0",
        muted: "#a9adb1",
        grid: "#3b3e43",
        raised: "#ffffff0a",
        accent: "#a8b9e9",
      };
}
