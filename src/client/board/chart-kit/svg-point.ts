// Adapted from Bklit UI's scatter-svg.ts and use-scatter-chart-interaction.ts
// (MIT, bklit/bklit-ui@76299da).
export function svgLocalPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  width: number,
  height: number,
) {
  const matrix = svg.getScreenCTM?.();
  if (
    matrix &&
    svg.createSVGPoint &&
    matrix.a * matrix.d !== matrix.b * matrix.c
  ) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  }
  const rect = svg.getBoundingClientRect();
  return rect.width && rect.height
    ? {
        x: ((clientX - rect.left) * width) / rect.width,
        y: ((clientY - rect.top) * height) / rect.height,
      }
    : null;
}
