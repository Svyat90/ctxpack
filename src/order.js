// Tree order: at every level directories come before files, then plain code-point order.
export function compareTree(a, b) {
  const A = a.split('/');
  const B = b.split('/');
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] === B[i]) continue;
    const aDir = i < A.length - 1;
    const bDir = i < B.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return A[i] < B[i] ? -1 : 1;
  }
  return A.length - B.length;
}

export const orderPaths = paths => [...paths].sort(compareTree);
