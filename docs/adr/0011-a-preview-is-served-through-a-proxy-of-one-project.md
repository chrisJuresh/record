# A Preview is served through a proxy of one Project

A Preview plays an Action live against the running Project, inside the app. For
that to work the app has to be able to script the Project's page — and it
cannot, because the Project answers on its own port and the app on the server's,
so an iframe of it is cross-origin.

`record serve` therefore offers a **Preview origin**: a proxy of one Project,
mounted at its root, bound to loopback, allocated the first time a Preview of
that Project is asked for. The page comes back through an origin the app owns,
carrying a driver the app can `postMessage` where to scroll to.

This is the **only** logic `record serve` holds that is not a `record` command
invoked and read back, which is why it is written down here.

Three things are deliberate about its shape.

**Root-mounted**, onto the Project's own origin, because the site's absolute
URLs have to keep resolving: a Preview of a page whose stylesheet 404s is a
Preview of a different page. **Per Project**, because which Project is being
previewed is then a fact about the origin rather than state the server carries.
**Every method passes through**, because a site whose grid is fed by its own API
has to keep working while it is scrolled.

It proxies that Project's origin and nothing else, and refuses anything that is
not under it — spelled absolutely, protocol-relative, or any other way. This
tool has not put a general proxy on the machine.

## What the command still owns

The driver injected into the page is **emitted by `record timeline`** and
relayed by the server, rather than written here. That matters beyond tidiness:
the driver has to find the scroller the way capture finds it and disable smooth
scrolling the way capture disables it, or a Preview scrolls a different element
than the clip does. One expression, in `packages/core/src/page.ts`, used by both.

So is the rule about which Actions can be previewed at all. A Preview drives a
**live** site, so an Action that clicks, types, evaluates an expression or waits
on the page is refused — tuning an Action must never be able to triage a real
photo library. That refusal is `record timeline --preview`, along with the
refusal for a Project that is not answering, and the server asks for both before
it allocates an origin or the app puts a frame in the page.

## Consequences

The injected driver scrolls and does nothing else. There is no path through it
by which a Preview could click, type or evaluate anything in the page, which is
the second half of what protects a live site — the first half being the refusal
above.

Two headers of the Project's own are taken off on the way back: `X-Frame-Options`
and `Content-Security-Policy`. A page refusing to be framed cannot be shown in
the app at all, and a policy forbidding inline script would drop the driver on
the floor. Taken off here rather than asked of the Project, because a Project
must not have to be configured for the sake of being previewed, and nothing
reaches this origin but the app on this machine.

Injection is into HTML responses only, and only where the Project answered in
bytes the proxy can read — requests go upstream asking for `identity`, and a
response that arrived encoded anyway is passed through untouched.

The origin lives as long as the server does, and is allocated once per Project.
A Parameter change must not put a new origin on this machine any more than it
puts a new frame in the page.

Only the proxy is new. ADR 0002 still describes the whole server: the Preview
origin binds loopback and answers a loopback `Host` and nothing else. ADR 0005
still holds too — a Preview writes nothing, so asking for one cannot change what
a Run would record.

The fallback, if the proxy had not been able to carry a real Project, was a warm
headless browser held open by the server streaming a screencast into the app:
full fidelity, no cross-origin problem, and a round trip per frame. It was not
needed. `apps/cli/test/preview.test.ts` is the evidence the proxy carries a
site — a page injected into, a stylesheet untouched, and the site's own absolute
URLs resolving through the origin.
