import { memo, useId, useMemo } from "react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import type { BoardDocument, PresentationSlide } from "../../shared/types";
import ArtifactNode, { BoardActions } from "./ArtifactNode";
import BoardEdgeView, { type BoardFlowEdge } from "./BoardEdgeView";
import { toBoardFlow, type BoardCanvasNode } from "./edge-flow";
import { presentationSlideContent } from "./presentation-model";

const noop = () => {};
const staticNodeTypes = { artifact: ArtifactNode, "edge-anchor": () => null };
const staticEdgeTypes = { board: BoardEdgeView };
const noSelection = new Set<string>();

function PresentationScene({
  document,
  boardId,
  slide,
  scale = 1,
}: {
  document: BoardDocument;
  boardId: string;
  slide: PresentationSlide;
  scale?: number;
}) {
  const flowId = useId();
  const viewport = useMemo(() => ({ x: 0, y: 0, zoom: scale }), [scale]);
  const actions = useMemo(
    () => ({
      boardId,
      editable: false,
      presentation: true,
      slideBackground: slide.background,
      reportChartStatus: false,
      update: noop,
      remove: noop,
      refresh: noop,
      openSource: noop,
      inspect: noop,
      metadata: noop,
      resizeStart: noop,
      resize: noop,
      busy: {},
    }),
    [boardId, slide.background],
  );
  const scene = useMemo(() => {
    const elements = presentationSlideContent(document, slide.id);
    const rendered = toBoardFlow({ ...document, ...elements }, noSelection);
    const edges = rendered.edges.map(
      ({ edge, source, target }): BoardFlowEdge => ({
        ...edge,
        source,
        target,
        sourceHandle: edge.sourceHandle ?? "right",
        targetHandle: edge.targetHandle ?? "left",
        type: "board",
        data: {
          edge,
          editable: false,
          editing: false,
          onEdit: noop,
          onFinishEdit: noop,
          onChange: noop,
          onGeometryChange: noop,
          onDelete: noop,
          onClose: noop,
        },
      }),
    );
    return { nodes: rendered.nodes, edges };
  }, [document, slide.id]);
  return (
    <ReactFlowProvider>
      <BoardActions.Provider value={actions}>
        <ReactFlow<BoardCanvasNode, BoardFlowEdge>
          id={flowId}
          className="presentation-readonly-flow"
          colorMode="dark"
          viewport={viewport}
          minZoom={0.005}
          nodes={scene.nodes}
          edges={scene.edges}
          nodeTypes={staticNodeTypes}
          edgeTypes={staticEdgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          preventScrolling={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          panActivationKeyCode={null}
          zoomActivationKeyCode={null}
          proOptions={{ hideAttribution: true }}
        />
      </BoardActions.Provider>
    </ReactFlowProvider>
  );
}

export default memo(PresentationScene);
