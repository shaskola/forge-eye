export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

export type WorkArea = {
  x: number
  y: number
  width: number
  height: number
}

/** Bottom-left of the overlay in screen coordinates. Height changes grow or shrink upward. */
export type Anchor = {
  x: number
  bottom: number
}

export const DEFAULT_MARGIN = 24

export function defaultAnchor(workArea: WorkArea, margin = DEFAULT_MARGIN): Anchor {
  return {
    x: workArea.x + margin,
    bottom: workArea.y + workArea.height - margin,
  }
}

export function anchorFromBounds(bounds: Rect): Anchor {
  return {
    x: bounds.x,
    bottom: bounds.y + bounds.height,
  }
}

export function boundsFromAnchor(
  anchor: Anchor,
  width: number,
  height: number,
  workArea: WorkArea,
): Rect {
  const h = Math.min(height, Math.max(120, workArea.height))
  const w = Math.min(width, Math.max(1, workArea.width))
  const minX = workArea.x
  const maxX = workArea.x + workArea.width - w
  const minY = workArea.y
  const maxY = workArea.y + workArea.height - h
  const x = Math.round(Math.min(Math.max(anchor.x, minX), Math.max(minX, maxX)))
  const y = Math.round(Math.min(Math.max(anchor.bottom - h, minY), Math.max(minY, maxY)))
  return { x, y, width: w, height: h }
}
