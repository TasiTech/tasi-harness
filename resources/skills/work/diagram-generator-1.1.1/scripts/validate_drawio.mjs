#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node scripts/validate_drawio.mjs <file-or-directory>");
  process.exit(2);
}

function listDrawioFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(target)
    .filter((name) => name.toLowerCase().endsWith(".drawio"))
    .map((name) => path.join(target, name));
}

function count(pattern, text) {
  return [...text.matchAll(pattern)].length;
}

function validateFile(file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");
  const issues = [];
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (hasBom) {
    issues.push({
      code: "utf8_bom",
      count: 1,
      message: "Write .drawio files as UTF-8 without BOM; diagrams.net may reject BOM-prefixed files as invalid data.",
    });
  }

  if (!text.trimStart().startsWith("<?xml")) {
    issues.push({
      code: "missing_xml_declaration",
      count: 1,
      message: 'Start editable .drawio files with <?xml version="1.0" encoding="UTF-8"?>.',
    });
  }

  const legacyAttrs = count(/\bas(?:Geometry|Point)="true"/g, text);
  if (legacyAttrs) {
    issues.push({
      code: "legacy_as_attribute",
      count: legacyAttrs,
      message: 'Use as="geometry", as="sourcePoint", or as="targetPoint"; never asGeometry="true".',
    });
  }

  const badGeometry = count(/<mxGeometry(?![^>]*\bas="geometry")/g, text);
  if (badGeometry) {
    issues.push({
      code: "missing_geometry_as",
      count: badGeometry,
      message: 'Every mxGeometry child of mxCell must include as="geometry".',
    });
  }

  const hasRoot = /<mxfile\b[\s\S]*<diagram\b[\s\S]*<mxGraphModel\b[\s\S]*<root\b/.test(text);
  if (!hasRoot) {
    issues.push({
      code: "missing_drawio_root",
      count: 1,
      message: "File does not look like a complete editable Draw.io mxfile.",
    });
  }

  return { file, ok: issues.length === 0, issues };
}

const target = process.argv[2];
if (!target) usage();

const files = listDrawioFiles(target);
const reports = files.map(validateFile);
const ok = reports.every((report) => report.ok);
console.log(JSON.stringify({ ok, files: reports }, null, 2));
process.exit(ok ? 0 : 1);
