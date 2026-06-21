// Shared compact scalar formatter.
//
// PlotPanel, TablePanel and ValuePanel each carried a byte-identical copy of
// this (PlotPanel's even noted "Mirrors TablePanel.formatValue"). One copy now
// keeps the three readouts agreeing on how a sample reads: compact ~4 sig-fig
// rendering — enough to read the value without dominating a narrow row, with
// exponential notation for very large / very small magnitudes.

export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return v.toExponential(3);
  return v.toFixed(3);
}
