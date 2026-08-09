/**
 * Scroll down a little and back up: enough of the grid moves past to show what
 * the page is, and it returns to where it started so the clip loops without a
 * snap. The Holds at either end are what make the loop read as a pause rather
 * than a stutter.
 */
import { motion, type Action } from "@record/core";

const parameters = {
  holdIn: {
    kind: "number",
    describes: "Still at the top before anything moves, in milliseconds",
    default: 400,
    min: 0,
    max: 2000,
  },
  distance: {
    kind: "number",
    describes: "How far down the page travels, in CSS pixels",
    default: 180,
    min: 20,
    max: 2000,
  },
  travel: {
    kind: "number",
    describes: "How long each leg of the travel takes, in milliseconds",
    default: 900,
    min: 100,
    max: 5000,
  },
  holdMid: {
    kind: "number",
    describes: "Still at the far end before turning back, in milliseconds",
    default: 250,
    min: 0,
    max: 2000,
  },
  holdOut: {
    kind: "number",
    describes: "Still at the top again once it has returned, in milliseconds",
    default: 400,
    min: 0,
    max: 2000,
  },
  framerate: {
    kind: "number",
    describes: "Frames per second",
    default: 60,
    min: 10,
    max: 120,
  },
  easing: {
    kind: "easing",
    describes: "How the travel accelerates and settles",
    default: "ease-in-out-cubic",
  },
} as const;

const scrollPeek: Action<typeof parameters> = {
  parameters,
  timeline({ holdIn, distance, travel, holdMid, holdOut, framerate, easing }) {
    return motion({ framerate })
      .hold(holdIn)
      .scrollTo(distance, { durationMs: travel, easing })
      .hold(holdMid)
      .scrollTo(0, { durationMs: travel, easing })
      .hold(holdOut);
  },
};

export default scrollPeek;
