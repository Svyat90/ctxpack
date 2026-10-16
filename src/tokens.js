// The corporate tokenizer is unknown, so this is a deliberately conservative estimate.
// Calibrate with `tokenCharsRatio` in .ctxpack.json.
export const estimateTokens = (text, ratio) => Math.ceil(text.length / ratio);

// Greedy packing that keeps file order and never splits a file.
// A single item larger than `cap` gets a part of its own.
export function packParts(items, cap) {
  const parts = [];
  let cur = [];
  let sum = 0;
  for (const it of items) {
    if (cur.length && sum + it.cost > cap) {
      parts.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(it);
    sum += it.cost;
  }
  if (cur.length) parts.push(cur);
  return parts;
}
