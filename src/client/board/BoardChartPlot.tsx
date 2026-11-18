import {
  Component,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  chartSeriesColor,
  supportsChartStacking,
} from "../../shared/chart-appearance";
import { ErrorBox } from "../components/UI";
import ChartCanvas from "./ChartCanvas";
import ChartSkeleton from "./ChartSkeleton";
import { chartOptions } from "./chartOptions";
import { presentationColors } from "./presentation-colors";
import CartesianPlot from "./chart-kit/CartesianPlot";
import MatrixPlot from "./chart-kit/MatrixPlot";
import TrendPlot from "./chart-kit/TrendPlot";
import type { ChartPlotProps } from "./chart-kit/plot-types";
import "./chart-kit/charts.css";

type Props = Omit<ChartPlotProps, "colors">;

function CompatibilityPlot({
  columns,
  spec,
  series,
  presentationBackground,
  label,
  loading,
}: Props) {
  const { option, createOption } = useMemo(() => {
    const build = (selected?: Record<string, boolean>) =>
      chartOptions(columns, spec, series, presentationBackground, selected);
    return {
      option: build(),
      createOption:
        spec.kind === "bar" && spec.stacked && spec.series ? build : undefined,
    };
  }, [columns, spec, series, presentationBackground]);
  return (
    <ChartCanvas
      option={option}
      createOption={createOption}
      label={label}
      loading={loading}
    />
  );
}

class PlotBoundary extends Component<
  { children: ReactNode; reset: Props },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: Readonly<{ reset: Props }>) {
    const next = this.props.reset;
    if (
      this.state.error &&
      (prev.reset.spec !== next.spec || prev.reset.series !== next.series)
    )
      this.setState({ error: undefined });
  }
  render() {
    if (this.state.error && this.props.reset.loading) return <ChartSkeleton />;
    return this.state.error ? (
      <ErrorBox
        className="board-error nowheel"
        title="Не удалось отобразить график."
        error={this.state.error}
        actions={
          <button
            type="button"
            onClick={() => this.setState({ error: undefined })}
          >
            Повторить
          </button>
        }
      />
    ) : (
      this.props.children
    );
  }
}

function ChartKitPlot(props: Props) {
  const { series, spec, presentationBackground } = props;
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const entries = useMemo(
    () =>
      series.map((item, index) => ({
        item,
        key: item.colorKey ?? String(index),
        color: chartSeriesColor(spec, item, index),
      })),
    [series, spec],
  );
  const data = useMemo(() => {
    const visible = entries.filter(
      (entry) => !spec.legend || !hidden.has(entry.key),
    );
    return {
      series: visible.map((entry) => entry.item),
      colors: visible.map((entry) => entry.color),
    };
  }, [entries, hidden, spec.legend]);
  const ink = presentationColors(presentationBackground ?? "#202124");
  const position = spec.legendPosition ?? "top";
  const Plot =
    spec.kind === "heatmap"
      ? MatrixPlot
      : spec.kind === "sparkline"
        ? TrendPlot
        : CartesianPlot;
  return (
    <div
      className="board-chart bk-chart"
      data-kind={spec.kind}
      data-legend-position={position}
      style={
        {
          "--bk-text": ink.text,
          "--bk-muted": ink.muted,
          "--bk-grid": ink.grid,
          "--bk-surface":
            presentationBackground ?? "var(--board-surface, #27292d)",
        } as CSSProperties
      }
    >
      {spec.legend && (
        <div
          className="bk-legend nowheel nodrag"
          role="group"
          aria-label="Легенда"
          data-align={spec.legendAlign ?? "center"}
        >
          {entries.map(({ item, key, color }) => (
            <button
              type="button"
              key={key}
              title={item.name}
              aria-pressed={!hidden.has(key)}
              onClick={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            >
              <span className="bk-key" style={{ background: color }} />
              <span>{item.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="bk-plot">
        {props.loading && (!data.series.length || Plot !== CartesianPlot) ? (
          <ChartSkeleton
            color={data.colors[0] ?? entries[0]?.color}
            count={series[0]?.data.length}
          />
        ) : data.series.length ? (
          <Plot key={spec.kind} {...props} {...data} />
        ) : (
          <div className="bk-no-series" role="status">
            Все ряды скрыты. Выберите ряд в легенде.
          </div>
        )}
      </div>
    </div>
  );
}

export default function BoardChartPlot(props: Props) {
  const { spec } = props;
  // ECharts retains signed stacked totals, legend recalculation and numeric scatter axes.
  const legacy =
    spec.kind === "scatter" ||
    (supportsChartStacking(spec.kind) && spec.stacked && spec.series);
  return (
    <PlotBoundary reset={props}>
      {legacy ? <CompatibilityPlot {...props} /> : <ChartKitPlot {...props} />}
    </PlotBoundary>
  );
}
