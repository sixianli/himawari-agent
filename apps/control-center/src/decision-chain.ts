import type { DecisionChain } from "./proactive.js";

export type DecisionChainMemory = DecisionChain["memories"]["items"][number];
export type BasisNode = DecisionChainMemory["basis"]["nodes"][number];

export interface BasisTree {
  readonly node: BasisNode;
  readonly children: readonly BasisTree[];
}

export function basisTree(nodes: readonly BasisNode[]): BasisTree | null {
  const first = nodes[0];
  if (!first) return null;
  const trees: { node: BasisNode; children: BasisTree[] }[] = nodes.map((node) => ({
    node,
    children: [],
  }));
  let next = 1;
  for (const tree of trees) {
    const wanted = tree.node.basisMemoryIds.length;
    for (let index = 0; index < wanted && next < trees.length; index += 1) {
      const child = trees[next];
      next += 1;
      if (child) tree.children.push(child);
    }
  }
  return trees[0] ?? null;
}
