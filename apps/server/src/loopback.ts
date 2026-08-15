/**
 * The one interface anything this tool serves will bind, and the only names a
 * request to it may be addressed by (ADR 0002).
 *
 * Both the API and a Preview origin answer here, and both have to refuse a
 * request addressed to anything else: a page on the open internet must not be
 * able to reach a tool that starts processes on this machine, nor to read the
 * site it is previewing.
 */

/** The only interface anything here will bind. Not an option: see ADR 0002. */
export const loopback = "127.0.0.1";

/** The host names a request may be addressed to, all of them this machine. */
const loopbackNames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Whether a request is addressed to this machine by one of its own names. */
export function addressedHere(host: string | undefined): boolean {
  if (host === undefined) {
    return true;
  }

  // A bracketed IPv6 host keeps its brackets; everything else loses its port.
  const named = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");

  return loopbackNames.has(named.toLowerCase());
}
