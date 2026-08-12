/**
 * How big a PNG the browser handed back actually is.
 *
 * Both the Frames and the rendered Mockups arrive as PNG bytes from
 * `HeadlessExperimental.beginFrame`, and the browser -- not this tool -- decides
 * what size they come out at: the device scale factor asked for through
 * `Emulation.setDeviceMetricsOverride` does not reach that screenshot, so an
 * image is CSS-sized however the viewport was emulated.
 *
 * So the size is read off the image rather than worked out from the viewport it
 * was asked for. Everything that composites a surround around a clip depends on
 * the two agreeing, and arithmetic that agrees only with itself is what let a
 * Mockup be laid over a quarter of its own canvas.
 */
import type { Dimensions } from "./artifacts.js";
import { RecordError } from "./errors.js";

/** What every PNG begins with, and the only bytes here that are not a size. */
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Where the IHDR chunk puts the two dimensions, as big-endian 32-bit counts. */
const widthAt = 16;
const heightAt = 20;

/** The size of a PNG, or a failure naming what was not one. */
export function pngDimensions(image: Buffer, describes: string): Dimensions {
  if (image.length < heightAt + 4 || !image.subarray(0, signature.length).equals(signature)) {
    throw new RecordError(`${describes} did not come back as a PNG`);
  }

  const size = { width: image.readUInt32BE(widthAt), height: image.readUInt32BE(heightAt) };

  if (size.width < 1 || size.height < 1) {
    throw new RecordError(`${describes} came back ${size.width}x${size.height}`);
  }

  return size;
}
