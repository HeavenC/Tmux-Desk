// Cross-session terminal search. tmux keeps every pane's scrollback, so "search
// everything I have running" is a capture-and-scan over `capture-pane`, not
// something the terminal front end could answer on its own (xterm.js sits on
// tmux's alternate screen and holds no history at all).
//
// Line addressing: `capture-pane -p -S -<n>` returns the pane's history plus the
// visible screen, oldest first, one entry per grid row (no -J: joining wrapped
// lines would break that 1:1 mapping). copy-mode's `goto-line` counts rows UP
// from the live bottom, row 0 being the bottom row — measured on tmux 3.7b.
// Count from the START of the capture, never from its length: capture-pane drops
// a trailing row, which makes a length-based formula land one row off. So
//   gotoLine = historySize + paneHeight - 1 - (capturedStart + index)
// with capturedStart = max(0, historySize - requestedLines), computed by the
// caller (gotoLineFor). Exact positioning is what lets a result in *another*
// session be opened right at its line; occurrence counting cannot do it — tmux's
// own search steps do not line up with a client-side count of matches.

const MAX_PREVIEW = 240;

function normalizeQuery(query) {
  return typeof query === 'string' ? query.trim() : '';
}

function scanPaneCapture(text, query, { caseSensitive = false, maxPerPane = 20 } = {}) {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  const lines = String(text ?? '').split('\n');
  const total = lines.length;
  const haystackNeedle = caseSensitive ? needle : needle.toLowerCase();
  const matches = [];
  // Newest first: the line someone is looking for is usually a recent one.
  for (let index = total - 1; index >= 0 && matches.length < maxPerPane; index -= 1) {
    const line = lines[index];
    const column = (caseSensitive ? line : line.toLowerCase()).indexOf(haystackNeedle);
    if (column < 0) continue;
    const preview = line.replace(/\s+$/, '');
    matches.push({
      index,
      column: Math.min(column, MAX_PREVIEW),
      length: needle.length,
      preview: preview.length > MAX_PREVIEW ? preview.slice(0, MAX_PREVIEW) : preview,
    });
  }
  return matches;
}

// Merge one pane's matches into the running result set, respecting the global
// cap so a query like "e" cannot drag megabytes into the renderer.
// Row offset copy-mode's goto-line needs for a captured line (see the note at
// the top of this file).
function gotoLineFor({ historySize, paneHeight, requestedLines }, index) {
  const capturedStart = Math.max(0, (historySize || 0) - (requestedLines || 0));
  return Math.max(0, (historySize || 0) + (paneHeight || 0) - 1 - (capturedStart + index));
}

function collectMatches(panes, { maxTotal = 200 } = {}) {
  const results = [];
  for (const { pane, matches } of panes) {
    for (const match of matches) {
      if (results.length >= maxTotal) return { results, truncated: true };
      results.push({ ...pane, ...match });
    }
  }
  return { results, truncated: false };
}

module.exports = { collectMatches, gotoLineFor, normalizeQuery, scanPaneCapture, MAX_PREVIEW };
