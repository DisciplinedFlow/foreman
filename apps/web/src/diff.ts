// Minimal LCS line diff for overview revision history (OVW-2). O(n·m) on line
// counts — overview sections are short prose, never large files.

export interface DiffLine { op: "same" | "add" | "del"; text: string }

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length, m = b.length;
  // lcs[i][j] = LCS length of a[i..] vs b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: "same", text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { out.push({ op: "del", text: a[i]! }); i++; }
    else { out.push({ op: "add", text: b[j]! }); j++; }
  }
  while (i < n) { out.push({ op: "del", text: a[i]! }); i++; }
  while (j < m) { out.push({ op: "add", text: b[j]! }); j++; }
  return out;
}
