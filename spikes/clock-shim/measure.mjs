// Reads the fixture's state back out of a captured frame.
//
// Each animated element is a solid bar of a known colour. Counting how many
// pixels of that colour sit on a given scanline recovers the animated width to
// the pixel, which is a far stronger assertion than "the image changed".
import { PNG } from "pngjs";

const COLOURS = {
  transition: [255, 0, 0],
  keyframes: [0, 255, 0],
  raf: [0, 0, 255],
  timerPending: [255, 0, 255],
  timerFired: [0, 255, 255],
};

// Scanline (CSS px) running through the middle of each 60px row.
const ROWS = { transition: 20, keyframes: 80, raf: 140, timer: 200 };

export function measure(pngBuffer, scale = 1) {
  const png = PNG.sync.read(pngBuffer);
  const widthAt = (row, rgb) => {
    const y = Math.round(row * scale);
    let count = 0;
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      if (png.data[i] === rgb[0] && png.data[i + 1] === rgb[1] && png.data[i + 2] === rgb[2]) count++;
    }
    return count / scale;
  };
  return {
    transition: widthAt(ROWS.transition, COLOURS.transition),
    keyframes: widthAt(ROWS.keyframes, COLOURS.keyframes),
    raf: widthAt(ROWS.raf, COLOURS.raf),
    timerFired: widthAt(ROWS.timer, COLOURS.timerFired) > 0,
  };
}
