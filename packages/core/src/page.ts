/**
 * The expressions this tool evaluates inside a Project's own page.
 *
 * They live here rather than beside capture because capture is no longer the
 * only thing that scrolls a Project: a Preview drives the live site from the
 * app, and a Preview that scrolled a different element than the clip does would
 * be a Preview of motion nobody is going to record. One expression, used by
 * both.
 */

/** Smooth scrolling would fight a scroll position chosen per Frame. */
export const stopSmoothScrolling = `
  (() => {
    const style = document.createElement("style");
    style.textContent = "*,html,body{scroll-behavior:auto !important}";
    document.head.appendChild(style);
  })()
`;

/**
 * The page may scroll the document or an inner container. Whichever actually
 * scrolls is found once and driven for the whole Run, so that the Frames of one
 * Action cannot be split across two scrollers.
 */
export const findScroller = `
  (() => {
    const document_ = document.scrollingElement || document.documentElement;
    if (document_.scrollHeight > document_.clientHeight + 4) {
      window.__recordScroller = document_;
      return;
    }
    let best = null;
    let deepest = 0;
    for (const element of document.querySelectorAll("*")) {
      const overflow = element.scrollHeight - element.clientHeight;
      const scrollable = /(auto|scroll)/.test(getComputedStyle(element).overflowY);
      if (scrollable && overflow > deepest) {
        best = element;
        deepest = overflow;
      }
    }
    window.__recordScroller = best || document_;
  })()
`;
