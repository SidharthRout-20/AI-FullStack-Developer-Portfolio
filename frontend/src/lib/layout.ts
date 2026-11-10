import type { GraphTopology } from '../types'

export interface Positioned {
  id: string
  x: number
  y: number
}

const START = '__start__'
const END = '__end__'

/**
 * Tiny left-to-right layered layout ("Sugiyama-lite") for a small DAG:
 *  1. rank = longest distance from START → column (x)
 *  2. nodes on the longest START→END path form the centre lane (y = 0): the "happy path"
 *  3. branch nodes go to lanes above / below, alternating, so branches never overlap
 * Good enough for ~10 nodes and avoids pulling in a layout library.
 */
export function layoutGraph(topo: GraphTopology, gapX = 232, gapY = 118): Positioned[] {
  const out = new Map<string, string[]>()
  topo.nodes.forEach((n) => out.set(n.id, []))
  topo.edges.forEach((e) => out.get(e.source)?.push(e.target))

  // Longest-path ranks via DFS (graph is acyclic).
  const rank = new Map<string, number>([[START, 0]])
  const visit = (id: string) => {
    for (const next of out.get(id) ?? []) {
      const r = (rank.get(id) ?? 0) + 1
      if (r > (rank.get(next) ?? -1)) {
        rank.set(next, r)
        visit(next)
      }
    }
  }
  visit(START)

  // Happy path = longest chain: walk back from END choosing the highest-ranked parent.
  const parents = new Map<string, string[]>()
  topo.edges.forEach((e) => parents.set(e.target, [...(parents.get(e.target) ?? []), e.source]))
  const order = new Map(topo.nodes.map((n, i) => [n.id, i]))
  const better = (a: string, b: string) => {
    const ra = rank.get(a) ?? 0
    const rb = rank.get(b) ?? 0
    // Tie-break by declaration order: the backend declares the primary node first.
    return ra !== rb ? ra > rb : (order.get(a) ?? 0) <= (order.get(b) ?? 0)
  }
  const main = new Set<string>([END])
  let cur = END
  while (cur !== START) {
    const ps = parents.get(cur) ?? []
    if (!ps.length) break
    cur = ps.reduce((a, b) => (better(a, b) ? a : b))
    main.add(cur)
  }

  const byRank = [...topo.nodes].sort(
    (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  )
  let side = 0
  return byRank.map(({ id }) => {
    const x = (rank.get(id) ?? 0) * gapX
    if (main.has(id)) return { id, x, y: 0 }
    const lane = side++
    const dir = lane % 2 === 0 ? -1 : 1 // first branch above, next below, …
    return { id, x, y: dir * gapY * (Math.floor(lane / 2) + 1) }
  })
}
