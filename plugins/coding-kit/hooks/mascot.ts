// The pane's mascot: a pixel Claude with a ponytail at a laptop with a green prompt.
type Px = [number, number]
const CLAUDE = '#d97757'
const INK = '#2b1d16'
const HAIR = '#7c2d12'
const LAPTOP = '#57534e'
const SCREEN = '#16a34a'

const block = (x0: number, y0: number, x1: number, y1: number): Px[] => {
  const out: Px[] = []
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y])
  return out
}
const rects = (px: Px[], color: string) => px.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`).join('')

let cached = ''

export function coderSvg(width = 72, height = 48): string {
  if (cached) return cached
  const body = [...block(3, 4, 10, 11), [2, 7], [2, 8]] as Px[]
  const hair = [...block(3, 2, 10, 3), [11, 3], [12, 4], [12, 5], [13, 6], [13, 7]] as Px[]
  const eyes: Px[] = [[5, 6], [5, 7], [8, 6], [8, 7]]
  const legs: Px[] = [[4, 12], [4, 13], [9, 12], [9, 13]]
  const laptop = [...block(13, 9, 22, 14), ...block(11, 14, 22, 14)] as Px[]
  const screen = block(14, 10, 21, 13)
  const prompt: Px[] = [[15, 11], [16, 12], [15, 13], [18, 13], [19, 13]]
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16" width="${width}" height="${height}" shape-rendering="crispEdges">` +
    rects(hair, HAIR) + rects(body, CLAUDE) + rects(eyes, INK) + rects(legs, CLAUDE) +
    rects(laptop, LAPTOP) + rects(screen, INK) + rects(prompt, SCREEN) +
    `</svg>`
  cached = svg
  return svg
}
