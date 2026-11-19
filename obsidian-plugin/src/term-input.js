// A paste or key press goes to the plugin as ONE input message; one over its limit is dropped whole, never cut.
import { MAX_INPUT } from "./mirror-session";

/** The message for the port, or null when there is nothing to send or the text is over the plugin's limit. */
function inputMessage(text) {
  return text.length > 0 && text.length <= MAX_INPUT ? { type: "input", text } : null;
}

export { inputMessage };
