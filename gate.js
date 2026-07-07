/* Shared state for the spoken write-confirmation gate.
 * Single-user by design (fine for a demo). For multi-user, key these by
 * conversationId and pass that id from the client on every turn. */

let pending = null; // { id, status, comment, subject } — staged but not sent
let lastCommit = null; // { id, status, subject } — set right after a successful write

export const getPending = () => pending;
export const setPending = (p) => {
  pending = p;
};
export const clearPending = () => {
  pending = null;
};

export const setLastCommit = (c) => {
  lastCommit = c;
};
// Read-once: returns the last commit and clears it, so the UI banner fires only once.
export const takeLastCommit = () => {
  const c = lastCommit;
  lastCommit = null;
  return c;
};
