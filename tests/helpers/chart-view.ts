import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import BoardChartPlot from "../../src/client/board/BoardChartPlot";

type Props = ComponentProps<typeof BoardChartPlot>;

export async function mountChart(props: Props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  async function render(next: Props) {
    await act(async () => root.render(createElement(BoardChartPlot, next)));
  }
  await render(props);
  return {
    host,
    render,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
