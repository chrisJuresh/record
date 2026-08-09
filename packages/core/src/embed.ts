/**
 * The snippet that puts a Run's clip on a web page.
 *
 * A page wants a video element rather than the GIF, and that element wants both
 * video Artifacts: WebM first because it is far the smaller, and the MP4 behind
 * it as the fallback older Safari needs (ADR 0006). Emitting it beside the
 * Artifacts means putting a clip on a page never requires remembering the
 * element's attributes.
 */

export type EmbedSources = {
  /** What the Artifacts are called, which is the Action's name. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
};

/**
 * A video element naming both video Artifacts.
 *
 * The sources are named relative to the snippet, because the Artifacts sit
 * beside it -- a path from this machine would make the folder uncopyable, which
 * is the one thing Publishing needs it to be.
 *
 * `muted` is not decoration: no browser autoplays a clip without it.
 */
export function embedSnippet({ name, width, height }: EmbedSources): string {
  return [
    `<video width="${width}" height="${height}" autoplay loop muted playsinline>`,
    `  <source src="${name}.webm" type="video/webm" />`,
    `  <source src="${name}.mp4" type="video/mp4" />`,
    "</video>",
    "",
  ].join("\n");
}
