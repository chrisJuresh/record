/**
 * A failure the person running the tool caused and can fix -- a missing
 * Project, a malformed `project.toml`. Reported as a message; anything else is
 * a defect and keeps its stack.
 */
export class RecordError extends Error {
  override readonly name = "RecordError";
}
