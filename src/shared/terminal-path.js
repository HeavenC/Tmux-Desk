'use strict';

/* A file path is handed to the foreground program by typing it into the prompt,
   where whitespace ends the token — `@/tmp/my notes.md` reaches an agent as a
   reference to `/tmp/my` plus the stray word `notes.md`. Escaping with
   backslashes is what a terminal itself does when a file is dropped onto it, so
   it is the form both shells and agents already expect.

   Uploaded files get their names sanitized before they land, but a *local* drop
   carries whatever the user named it, and directories above it (`~/My Drive`)
   are outside anyone's control. */
const NEEDS_ESCAPE = /[\s"'\\$`&|;<>()*?[\]{}~!#]/g;

function escapePathForTerminal(filePath) {
  return String(filePath || '').replace(NEEDS_ESCAPE, (char) => `\\${char}`);
}

/** `@<path> ` — the reference form agents read, with a trailing space so the
    next one starts its own token. */
function pathReference(filePath) {
  return `@${escapePathForTerminal(filePath)} `;
}

module.exports = { escapePathForTerminal, pathReference };
