#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

let DOMParser = null;
try {
  ({ DOMParser } = await import("@xmldom/xmldom"));
} catch {
  DOMParser = null;
}

function parseArgs(argv) {
  const args = { input: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (!arg.startsWith("--") && !args.input) args.input = arg;
  }
  return args;
}

function issue(code, message, files = [], severity = "error") {
  return { code, severity, files, message };
}

function parseAttrs(tag) {
  const attrs = {};
  const rx = /([\w:.-]+)="([^"]*)"/g;
  let match;
  while ((match = rx.exec(tag))) attrs[match[1]] = match[2];
  return attrs;
}

function parseRelationships(xml) {
  const rels = new Map();
  const rx = /<Relationship\b[^>]*>/g;
  let match;
  while ((match = rx.exec(xml))) {
    const attrs = parseAttrs(match[0]);
    if (attrs.Id) rels.set(attrs.Id, attrs);
  }
  return rels;
}

function relationshipBaseDir(relsPartName) {
  if (relsPartName === "_rels/.rels") return "";
  return relsPartName.replace(/_rels\/[^/]+\.rels$/i, "");
}

function normalizePart(baseDir, target) {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  return path.posix.normalize(path.posix.join(baseDir, target)).replace(/\\/g, "/");
}

function parseXmlIssues(partName, xml) {
  if (!DOMParser) return [];
  const errors = [];
  new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(xml, "application/xml");
  return errors;
}

function collectIds(xml, tagName) {
  const ids = [];
  const rx = new RegExp(`<${tagName}\\b[^>]*\\bid="(\\d+)"`, "g");
  let match;
  while ((match = rx.exec(xml))) ids.push(match[1]);
  return ids;
}

function duplicateCount(values) {
  const seen = new Set();
  let duplicates = 0;
  for (const value of values) {
    if (seen.has(value)) duplicates += 1;
    seen.add(value);
  }
  return duplicates;
}

function validMediaSignature(ext, data) {
  if (ext === ".png") return data.slice(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (ext === ".jpg" || ext === ".jpeg") return data[0] === 0xff && data[1] === 0xd8;
  if (ext === ".gif") return data.slice(0, 3).toString("ascii") === "GIF";
  if (ext === ".svg") return /<svg[\s>]/i.test(data.toString("utf8").slice(0, 1024));
  return true;
}

async function validate(input) {
  const report = {
    ok: false,
    input,
    issues: [],
    counts: {
      slides: 0,
      mediaFiles: 0,
      relationshipTargetsChecked: 0,
      xmlPartsChecked: 0,
    },
  };

  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(input));
  } catch (error) {
    report.issues.push(issue("invalid_zip", `PPTX is not a readable zip package: ${error.message}`));
    return report;
  }

  const requiredParts = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"];
  for (const part of requiredParts) {
    if (!zip.file(part)) report.issues.push(issue("missing_part", `Missing required PPTX part: ${part}`, [part]));
  }

  const xmlPartNames = Object.keys(zip.files).filter((name) => /\.(xml|rels)$/i.test(name) && !zip.files[name].dir);
  report.counts.xmlPartsChecked = xmlPartNames.length;
  for (const name of xmlPartNames) {
    const errors = parseXmlIssues(name, await zip.file(name).async("string"));
    if (errors.length) report.issues.push(issue("invalid_xml", `${name} is not well-formed XML: ${errors[0]}`, [name]));
  }
  if (!DOMParser) report.issues.push(issue("xml_parser_unavailable", "XML well-formedness check skipped because @xmldom/xmldom is not installed.", [], "warning"));

  for (const relsPartName of Object.keys(zip.files).filter((name) => name.endsWith(".rels") && !zip.files[name].dir)) {
    const baseDir = relationshipBaseDir(relsPartName);
    const rels = parseRelationships(await zip.file(relsPartName).async("string"));
    for (const rel of rels.values()) {
      if (rel.TargetMode === "External") continue;
      report.counts.relationshipTargetsChecked += 1;
      const target = normalizePart(baseDir, rel.Target || "");
      if (!zip.file(target)) report.issues.push(issue("missing_relationship_target", `${relsPartName} relationship ${rel.Id} points to missing part ${target}.`, [relsPartName]));
    }
  }

  if (zip.file("ppt/presentation.xml") && zip.file("ppt/_rels/presentation.xml.rels")) {
    const presentationXml = await zip.file("ppt/presentation.xml").async("string");
    const presentationRels = parseRelationships(await zip.file("ppt/_rels/presentation.xml.rels").async("string"));
    const slideRefs = [...presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((match) => match[1]);
    report.counts.slides = slideRefs.length;
    if (!slideRefs.length) report.issues.push(issue("missing_slides", "ppt/presentation.xml contains no slide references."));
    for (const relId of slideRefs) {
      const rel = presentationRels.get(relId);
      if (!rel) {
        report.issues.push(issue("missing_slide_relationship", `Slide reference ${relId} has no presentation relationship.`));
        continue;
      }
      const slidePart = normalizePart("ppt", rel.Target || "");
      if (!zip.file(slidePart)) report.issues.push(issue("missing_slide_part", `Slide relationship ${relId} points to missing part ${slidePart}.`, [slidePart]));
    }
  }

  for (const slidePart of Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))) {
    const slideXml = await zip.file(slidePart).async("string");
    const docPrDuplicates = duplicateCount(collectIds(slideXml, "p:cNvPr"));
    if (docPrDuplicates) report.issues.push(issue("duplicate_slide_cNvPr_id", `${slidePart} contains duplicate p:cNvPr ids.`, [slidePart]));
  }

  const mediaFiles = Object.keys(zip.files).filter((name) => /^ppt\/media\/[^/]+$/i.test(name));
  report.counts.mediaFiles = mediaFiles.length;
  for (const name of mediaFiles) {
    const data = await zip.file(name).async("nodebuffer");
    const ext = path.extname(name).toLowerCase();
    if (!validMediaSignature(ext, data)) report.issues.push(issue("invalid_media_signature", `Embedded media has an invalid signature: ${name}`, [name]));
  }

  report.ok = !report.issues.some((item) => item.severity === "error");
  return report;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error("Usage: node scripts/validate_pptx.mjs --input file.pptx");
  process.exit(2);
}

const report = await validate(args.input);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
