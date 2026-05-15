#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function parseArgs(argv) {
  const args = { assetDir: null, drawioDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--asset-dir" || arg === "--png-dir") args.assetDir = argv[++i];
    else if (arg === "--drawio-dir") args.drawioDir = argv[++i];
    else if (!arg.startsWith("--") && !args.assetDir) args.assetDir = arg;
  }
  return args;
}

function usage() {
  console.error("Usage: node scripts/validate_diagram_exports.mjs --asset-dir diagrams/exports [--drawio-dir diagrams/drawio]");
  process.exit(2);
}

function listFiles(dir, extensions) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => extensions.includes(path.extname(name).toLowerCase()))
    .map((name) => path.join(dir, name));
}

function readPng(file) {
  const data = fs.readFileSync(file);
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (!data.subarray(0, 8).equals(signature)) {
    throw new Error("Invalid PNG signature");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  const channelsByType = new Map([[0, 1], [2, 3], [4, 2], [6, 4]]);
  const channels = channelsByType.get(colorType);
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType}`);

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const raw = Buffer.alloc(height * stride);
  let input = 0;
  let output = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[input++];
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[input++];
      const left = x >= channels ? raw[output + x - channels] : 0;
      const up = y > 0 ? raw[output + x - stride] : 0;
      const upLeft = y > 0 && x >= channels ? raw[output + x - stride - channels] : 0;
      let decoded;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
      else if (filter === 4) decoded = value + paeth(left, up, upLeft);
      else throw new Error(`Unsupported PNG filter: ${filter}`);
      raw[output + x] = decoded & 0xff;
    }
    output += stride;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < raw.length; i += channels, p += 4) {
    if (colorType === 0) {
      rgba[p] = raw[i];
      rgba[p + 1] = raw[i];
      rgba[p + 2] = raw[i];
      rgba[p + 3] = 255;
    } else if (colorType === 2) {
      rgba[p] = raw[i];
      rgba[p + 1] = raw[i + 1];
      rgba[p + 2] = raw[i + 2];
      rgba[p + 3] = 255;
    } else if (colorType === 4) {
      rgba[p] = raw[i];
      rgba[p + 1] = raw[i];
      rgba[p + 2] = raw[i];
      rgba[p + 3] = raw[i + 1];
    } else {
      rgba[p] = raw[i];
      rgba[p + 1] = raw[i + 1];
      rgba[p + 2] = raw[i + 2];
      rgba[p + 3] = raw[i + 3];
    }
  }

  return { file, width, height, data: rgba };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function isInk(data, index) {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const a = data[index + 3];
  return a > 16 && !(r > 245 && g > 245 && b > 245);
}

function countInkInBand(png, side, band = 8) {
  const { width, height, data } = png;
  let ink = 0;
  let total = 0;
  const yStart = side === "bottom" ? Math.max(0, height - band) : 0;
  const yEnd = side === "top" ? Math.min(height, band) : height;
  const xStart = side === "right" ? Math.max(0, width - band) : 0;
  const xEnd = side === "left" ? Math.min(width, band) : width;

  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      total += 1;
      if (isInk(data, (y * width + x) * 4)) ink += 1;
    }
  }
  return total ? ink / total : 0;
}

function inkBounds(png) {
  const { width, height, data } = png;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let ink = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isInk(data, (y * width + x) * 4)) continue;
      ink += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (!ink) return { ink, minX: null, minY: null, maxX: null, maxY: null };
  return { ink, minX, minY, maxX, maxY };
}

function issue(code, message, files = [], severity = "error") {
  return { code, severity, files, message };
}

function basenameNoExt(file) {
  return path.basename(file, path.extname(file)).toLowerCase();
}

function readTextFile(file) {
  return fs.readFileSync(file, "utf8");
}

function countDrawioEdges(file) {
  const xml = readTextFile(file);
  return (xml.match(/\bedge="1"/g) || []).length;
}

function inspectSvg(file) {
  const svg = readTextFile(file);
  return {
    file,
    hasSvgRoot: /<svg[\s>]/i.test(svg.slice(0, 2048)),
    hasViewBox: /\bviewBox="/i.test(svg.slice(0, 4096)),
    connectorPrimitiveCount: (svg.match(/<(?:path|line|polyline)\b/gi) || []).length,
    markerCount: (svg.match(/<marker\b/gi) || []).length,
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.assetDir) usage();

const pngFiles = listFiles(args.assetDir, [".png"]);
const svgFiles = listFiles(args.assetDir, [".svg"]);
const drawioFiles = listFiles(args.drawioDir, [".drawio"]);
const issues = [];

const svgByBase = new Map(svgFiles.map((file) => [basenameNoExt(file), file]));

const pngs = [];
for (const file of pngFiles) {
  try {
    pngs.push(readPng(file));
  } catch (error) {
    issues.push(issue("invalid_png", `Cannot read PNG: ${error.message}`, [file]));
  }
}

const dimensionGroups = new Map();
for (const png of pngs) {
  const key = `${png.width}x${png.height}`;
  if (!dimensionGroups.has(key)) dimensionGroups.set(key, []);
  dimensionGroups.get(key).push(png.file);
}

for (const [key, files] of dimensionGroups) {
  if (pngs.length >= 3 && files.length >= Math.ceil(pngs.length * 0.7)) {
    issues.push(issue(
      "uniform_viewport_sized_pngs",
      `Most exported PNGs have identical dimensions (${key}). This usually means browser viewport screenshots were used instead of per-diagram exports.`,
      files,
    ));
  }
}

for (const png of pngs) {
  const bounds = inkBounds(png);
  if (!bounds.ink || bounds.ink / (png.width * png.height) < 0.0005) {
    issues.push(issue(
      "blank_or_near_blank_png",
      "PNG has no visible diagram content or is nearly blank; SVG/Draw.io export likely failed.",
      [png.file],
    ));
    continue;
  }

  const bottomInk = countInkInBand(png, "bottom");
  const rightInk = countInkInBand(png, "right");
  const topInk = countInkInBand(png, "top");
  const leftInk = countInkInBand(png, "left");
  const sides = [];
  if (topInk > 0.02) sides.push(`top ${(topInk * 100).toFixed(1)}%`);
  if (leftInk > 0.02) sides.push(`left ${(leftInk * 100).toFixed(1)}%`);
  if (bottomInk > 0.02) sides.push(`bottom ${(bottomInk * 100).toFixed(1)}%`);
  if (rightInk > 0.02) sides.push(`right ${(rightInk * 100).toFixed(1)}%`);
  if (sides.length) {
    issues.push(issue(
      "content_touches_export_edge",
      `Visible content reaches the export edge (${sides.join(", ")}); the image may be cropped.`,
      [png.file],
    ));
  }

  const margin = 2;
  const bboxTouches = [];
  if (bounds.minX <= margin) bboxTouches.push("left");
  if (bounds.minY <= margin) bboxTouches.push("top");
  if (bounds.maxX >= png.width - 1 - margin) bboxTouches.push("right");
  if (bounds.maxY >= png.height - 1 - margin) bboxTouches.push("bottom");
  if (bboxTouches.length) {
    issues.push(issue(
      "ink_bbox_touches_canvas_edge",
      `Visible content bounding box touches the canvas edge (${bboxTouches.join(", ")}); regenerate from Draw.io/SVG with padding instead of using a screenshot crop.`,
      [png.file],
    ));
  }
}

if (drawioFiles.length) {
  const assets = new Set([...pngFiles, ...svgFiles].map(basenameNoExt));
  const missing = drawioFiles.filter((file) => !assets.has(basenameNoExt(file)));
  if (missing.length) {
    issues.push(issue(
      "missing_export_asset",
      "Some Draw.io sources have no matching PNG/SVG export asset by basename.",
      missing,
    ));
  }

  for (const drawioFile of drawioFiles) {
    const svgFile = svgByBase.get(basenameNoExt(drawioFile));
    if (!svgFile) continue;

    const edgeCount = countDrawioEdges(drawioFile);
    const svg = inspectSvg(svgFile);
    if (!svg.hasSvgRoot) {
      issues.push(issue("invalid_svg", "Exported SVG does not contain an <svg> root.", [svgFile]));
      continue;
    }
    if (!svg.hasViewBox) {
      issues.push(issue("svg_missing_viewbox", "Exported SVG is missing viewBox; export bounds may be viewport-derived or unstable.", [svgFile]));
    }
    if (edgeCount > 0 && svg.connectorPrimitiveCount === 0) {
      issues.push(issue(
        "svg_missing_connectors",
        `Draw.io source contains ${edgeCount} edge(s), but the matching SVG contains no path/line/polyline connector primitives. Regenerate with Draw.io/diagrams.net export instead of a hand-redraw or screenshot-derived SVG.`,
        [drawioFile, svgFile],
      ));
    }
  }
}

const report = {
  ok: !issues.some((item) => item.severity === "error"),
  assetDir: args.assetDir,
  drawioDir: args.drawioDir,
  counts: {
    png: pngFiles.length,
    svg: svgFiles.length,
    drawio: drawioFiles.length,
  },
  pngs: pngs.map((png) => ({ file: png.file, width: png.width, height: png.height, inkBounds: inkBounds(png) })),
  svgs: svgFiles.map((file) => {
    const drawioFile = drawioFiles.find((item) => basenameNoExt(item) === basenameNoExt(file));
    return {
      ...inspectSvg(file),
      matchingDrawioEdges: drawioFile ? countDrawioEdges(drawioFile) : null,
    };
  }),
  issues,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
