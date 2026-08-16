import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

const rootDir = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(rootDir, "public");
const iconDir = path.join(rootDir, "assets", "icons");
const green = "#16a34a";
const strokeWidth = 34;

const lineSegments = [
  [[96, 77], [96, 435]],
  [[296, 246], [296, 435]],
  [[416, 246], [416, 435]],
  [[296, 340], [416, 340]]
];

const paths = [
  "M96 77 H234 A94 94 0 0 1 234 265 H96"
];

function svg(background) {
  const lines = lineSegments
    .map(([[x1, y1], [x2, y2]]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
    .join("\n      ");
  const pathText = paths
    .map(pathData => `<path d="${pathData}"/>`)
    .join("\n      ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="ParkHunter icon">
  <rect width="512" height="512" fill="${background}"/>
  <g fill="none" stroke="${green}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
      ${pathText}
      ${lines}
  </g>
</svg>
`;
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16)
  ];
}

function scalePoint([x, y], size) {
  const scale = size / 512;
  return [
    x * scale,
    y * scale
  ];
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function drawLine(image, size, from, to, color, width) {
  const [r, g, b] = color;
  const [ax, ay] = scalePoint(from, size);
  const [bx, by] = scalePoint(to, size);
  const radius = width / 2;
  const padding = radius + 2;
  const left = Math.max(0, Math.floor(Math.min(ax, bx) - padding));
  const right = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + padding));
  const top = Math.max(0, Math.floor(Math.min(ay, by) - padding));
  const bottom = Math.min(size - 1, Math.ceil(Math.max(ay, by) + padding));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const distance = distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
      if (distance > radius + 1) {
        continue;
      }

      const alpha = Math.max(0, Math.min(1, radius + 1 - distance));
      const index = (y * size + x) * 4;
      image[index] = Math.round(image[index] * (1 - alpha) + r * alpha);
      image[index + 1] = Math.round(image[index + 1] * (1 - alpha) + g * alpha);
      image[index + 2] = Math.round(image[index + 2] * (1 - alpha) + b * alpha);
      image[index + 3] = 255;
    }
  }
}

function cubicPoint(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return [
    mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
    mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1]
  ];
}

function drawPolyline(image, size, points, color, width) {
  for (let index = 0; index < points.length - 1; index += 1) {
    drawLine(image, size, points[index], points[index + 1], color, width);
  }
}

function png(background, size = 512) {
  const [br, bg, bb] = hexToRgb(background);
  const image = Buffer.alloc(size * size * 4);
  for (let index = 0; index < image.length; index += 4) {
    image[index] = br;
    image[index + 1] = bg;
    image[index + 2] = bb;
    image[index + 3] = 255;
  }

  const pBowl = [];
  pBowl.push([96, 77], [234, 77]);
  for (let step = 1; step <= 24; step += 1) {
    const t = step / 24;
    pBowl.push(cubicPoint(t, [234, 77], [360, 77], [360, 265], [234, 265]));
  }
  pBowl.push([96, 265]);
  drawPolyline(image, size, pBowl, hexToRgb(green), size * strokeWidth / 512);

  for (const [from, to] of lineSegments) {
    drawLine(image, size, from, to, hexToRgb(green), size * strokeWidth / 512);
  }

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    scanlines[rowStart] = 0;
    image.copy(scanlines, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND")
  ]);
}

await mkdir(publicDir, { recursive: true });
await mkdir(iconDir, { recursive: true });

await writeFile(path.join(publicDir, "favicon.svg"), svg("#ffffff"));
await writeFile(path.join(iconDir, "parkhunter-browser.svg"), svg("#ffffff"));
await writeFile(path.join(iconDir, "parkhunter-streamdeck.svg"), svg("#000000"));
await writeFile(path.join(iconDir, "parkhunter-browser.png"), png("#ffffff"));
await writeFile(path.join(iconDir, "parkhunter-streamdeck.png"), png("#000000"));

console.log("Generated ParkHunter icons.");
