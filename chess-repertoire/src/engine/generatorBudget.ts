/** Each fork shares generated moves in proportion to its local reply frequencies. */
export interface BudgetBranch {
  weight: number;
  moves: number;
  children: BudgetBranch[];
}

export type BudgetPath = BudgetBranch[];

// Keep an unrecorded engine defense eligible for a small share. With no human
// data every reply has the same weight, so engine-only branching stays fair.
export const replyBudgetWeight = (playRate?: number): number =>
  playRate !== undefined && Number.isFinite(playRate) && playRate > 0 ? playRate : 1;

/** Compare work already spent at the first fork where two continuations differ. */
export function compareBudgetPaths(a: BudgetPath, b: BudgetPath): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return a[i].moves / a[i].weight - b[i].moves / b[i].weight
      || b[i].weight - a[i].weight
      || a[i - 1].children.indexOf(a[i]) - a[i - 1].children.indexOf(b[i]);
  }
  return a.length - b.length;
}

/** Count every added move against all the opponent branches it belongs to. */
export function chargeBudgetPath(path: BudgetPath): void {
  for (const branch of path) branch.moves++;
}

/** Remaining capacity after sharing each ancestor's budget and reserving its peers. */
export function continuationBudget(
  path: BudgetPath, maxMoves: number, reservations: Array<{ path: BudgetPath; moves: number }>,
): number {
  const reserved = new Map<BudgetBranch, number>();
  for (const item of reservations) {
    for (const branch of item.path) reserved.set(branch, (reserved.get(branch) ?? 0) + item.moves);
  }
  let capacity = maxMoves;
  for (let i = 1; i < path.length; i++) {
    // The virtual root costs no move; every other parent costs one.
    capacity -= i === 1 ? 0 : 1;
    let peers = path[i - 1].children.filter(branch => {
      if ((reserved.get(branch) ?? 0) > 0) return true;
      capacity -= branch.moves; // Finished branches return their unused share.
      return false;
    });
    // Honor already committed continuations before dividing spare capacity.
    // This is weighted sharing with a minimum for every live branch.
    while (peers.length) {
      const weight = peers.reduce((sum, branch) => sum + branch.weight, 0);
      const constrained = peers.filter(branch => branch.moves + (reserved.get(branch) ?? 0) > capacity * branch.weight / weight);
      if (!constrained.length) {
        capacity *= path[i].weight / weight;
        break;
      }
      if (constrained.includes(path[i])) {
        capacity = path[i].moves + (reserved.get(path[i]) ?? 0);
        break;
      }
      for (const branch of constrained) capacity -= branch.moves + (reserved.get(branch) ?? 0);
      peers = peers.filter(branch => !constrained.includes(branch));
    }
  }
  const active = path[path.length - 1];
  return capacity - active.moves - (reserved.get(active) ?? 0);
}
