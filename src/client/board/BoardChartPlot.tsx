import {
  Component,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  chartSeriesColor,
  composedMetricStyle,
} from "../../shared/chart-appearance";
import { ErrorBox } from "../components/UI";
import ChartSkeleton from "./ChartSkeleton";
import ScatterPlot from "./chart-kit/ScatterPlot";
import { presentationColors } from "./presentation-colors";
import CartesianPlot from "./chart-kit/CartesianPlot";
import MatrixPlot from "./chart-kit/MatrixPlot";
import HistogramPlot from "./chart-kit/HistogramPlot";
import TrendPlot from "./chart-kit/TrendPlot";
import { useChartPaint } from "./chart-kit/mark-paint";
import type { ChartPlotProps } from "./chart-kit/plot-types";
import type { ChartKind, ChartMarkStyle } from "../../shared/types";
import "./chart-kit/charts.css";

type Props = Omit<ChartPlotProps, "colors">;

function StyledKey({
  style,
  color,
  line,
}: {
  style: ChartMarkStyle;
  color: string;
  line: boolean;
}) {
  const series = useMemo(
    () => [{ name: "", data: [], seriesStyle: style }],
    [style],
  );
  const colors = useMemo(() => [color], [color]);
  const paint = useChartPaint(series, colors);
  const outline = line && paint.outline(style, color, 2);
  return (
    <svg aria-hidden="true" width="20" height="12" style={{ flex: "none" }}>
      {paint.defs}
      {line ? (
        <>
          {outline && <path d="M1 6H19" {...outline} />}
          <path d="M1 6H19" {...paint.line(style, color, 2)} />
        </>
      ) : (
        <rect
          x="3"
          y="2"
          width="14"
          height="8"
          rx="2"
          {...paint.fill(style, color)}
        />
      )}
    </svg>
  );
}

const plots = {
  bar: CartesianPlot,
  line: CartesianPlot,
  area: CartesianPlot,
  composed: CartesianPlot,
  heatmap: MatrixPlot,
  histogram: HistogramPlot,
  sparkline: TrendPlot,
  scatter: ScatterPlot,
} satisfies Record<ChartKind, (props: ChartPlotProps) => ReactNode>;

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
    if (this.state.error && this.props.reset.loading)
      return <ChartSkeleton spec={this.props.reset.spec} />;
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
  const showLegend = spec.kind !== "histogram" && spec.legend;
  const entries = useMemo(
    () =>
      series.map((item, index) => ({
        item,
        key: item.colorKey ?? String(index),
        color: chartSeriesColor(spec, item, index),
      })),
    [series, spec],
  );
  useEffect(() => {
    if (props.loading) return;
    setHidden((previous) => {
      if (!previous.size) return previous;
      const remaining = new Set(
        entries
          .filter((entry) => previous.has(entry.key))
          .map((entry) => entry.key),
      );
      return remaining.size === previous.size ? previous : remaining;
    });
  }, [entries, props.loading]);
  const data = useMemo(() => {
    const visible = showLegend
      ? entries.filter((entry) => !hidden.has(entry.key))
      : entries;
    return {
      series: visible.map((entry) => entry.item),
      colors: visible.map((entry) => entry.color),
    };
  }, [entries, hidden, showLegend]);
  const ink = presentationBackground
    ? presentationColors(presentationBackground)
    : undefined;
  const position = spec.legendPosition ?? "top";
  const Plot = plots[spec.kind];
  return (
    <div
      className="board-chart bk-chart"
      data-kind={spec.kind}
      data-legend-position={showLegend ? position : undefined}
      style={
        {
          "--bk-text": ink?.text ?? "var(--board-text, #eeeff0)",
          "--bk-muted": ink?.muted ?? "var(--board-muted, #a9adb1)",
          "--bk-grid": ink?.grid ?? "var(--board-border, #3b3e43)",
          "--bk-surface":
            presentationBackground ?? "var(--board-surface, #27292d)",
        } as CSSProperties
      }
    >
      {showLegend && (
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
              {item.seriesStyle ? (
                <StyledKey
                  style={item.seriesStyle}
                  color={color}
                  line={
                    spec.kind === "line" ||
                    spec.kind === "sparkline" ||
                    (spec.kind === "composed" &&
                      composedMetricStyle(spec, item.metricId ?? spec.y[0]) ===
                        "line")
                  }
                />
              ) : (
                <span className="bk-key" style={{ background: color }} />
              )}
              <span>{item.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="bk-plot">
        {props.loading && !entries.length ? (
          <ChartSkeleton
            spec={spec}
            count={series[0]?.xCategories?.length ?? series[0]?.data.length}
          />
        ) : data.series.length ||
          (spec.kind === "histogram" && !entries.length) ? (
          <Plot
            key={spec.kind}
            {...props}
            series={data.series}
            colors={data.colors}
          />
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
  return (
    <PlotBoundary reset={props}>
      <ChartKitPlot {...props} />
    </PlotBoundary>
  );
}
