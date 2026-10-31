import { Agent, fetch as packageFetch } from "undici";

// Imported fetch alone can reuse Node's built-in global dispatcher. Own the
// package dispatcher too, so native smoke tests exercise its socket handling.
export function createNativeFetch() {
  const dispatcher = new Agent();
  return {
    fetch: (input, options = {}) =>
      packageFetch(input, { ...options, dispatcher }),
    destroy: () => dispatcher.destroy(),
  };
}
