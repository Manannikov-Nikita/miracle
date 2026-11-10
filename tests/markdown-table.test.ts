import { describe, expect, it } from "vitest";
import { tableToMarkdown } from "../src/shared/markdown-table";

describe("Markdown table export", () => {
  it("writes headers, a separator and every row including empty cells", () => {
    expect(
      tableToMarkdown(
        ["Имя", "Число"],
        [
          ["A", "0"],
          ["", "NULL"],
        ],
      ),
    ).toBe("| Имя | Число |\n| --- | --- |\n| A | 0 |\n|  | NULL |");
    expect(tableToMarkdown(["Имя"], [])).toBe("| Имя |\n| --- |");
  });

  it("keeps pipes, newlines, HTML and Markdown syntax inside their cells", () => {
    expect(
      tableToMarkdown(
        ["A|B", "<name>"],
        [["**bold** \\ `$x$`", "one\r\ntwo\rthree\nfour & <b>"]],
      ),
    ).toBe(
      "| A\\|B | &lt;name&gt; |\n| --- | --- |\n| \\*\\*bold\\*\\* \\\\ \\`\\$x\\$\\` | one<br>two<br>three<br>four &amp; &lt;b&gt; |",
    );
  });
});
