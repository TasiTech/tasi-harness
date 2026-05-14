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

function colToNumber(col) {
  let result = 0;
  for (const ch of col.toUpperCase()) result = result * 26 + ch.charCodeAt(0) - 64;
  return result;
}

function parseCellRef(ref) {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!match) return null;
  return { col: colToNumber(match[1]), row: Number(match[2]) };
}

function validRange(range) {
  const [start, end = start] = range.split(":");
  const a = parseCellRef(start);
  const b = parseCellRef(end);
  return Boolean(a && b && a.row > 0 && b.row > 0 && a.col > 0 && b.col > 0 && a.row <= b.row && a.col <= b.col);
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
      sheets: 0,
      mediaFiles: 0,
      relationshipTargetsChecked: 0,
      sharedStrings: 0,
      xmlPartsChecked: 0,
    },
  };

  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(input));
  } catch (error) {
    report.issues.push(issue("invalid_zip", `XLSX is not a readable zip package: ${error.message}`));
    return report;
  }

  const requiredParts = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"];
  for (const part of requiredParts) {
    if (!zip.file(part)) report.issues.push(issue("missing_part", `Missing required XLSX part: ${part}`, [part]));
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

  let sharedStringCount = 0;
  if (zip.file("xl/sharedStrings.xml")) {
    const sharedXml = await zip.file("xl/sharedStrings.xml").async("string");
    sharedStringCount = [...sharedXml.matchAll(/<si\b/g)].length;
    report.counts.sharedStrings = sharedStringCount;
  }

  let cellXfsCount = 0;
  if (zip.file("xl/styles.xml")) {
    const stylesXml = await zip.file("xl/styles.xml").async("string");
    const cellXfsMatch = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (cellXfsMatch) cellXfsCount = [...cellXfsMatch[1].matchAll(/<xf\b/g)].length;
  }

  if (zip.file("xl/workbook.xml") && zip.file("xl/_rels/workbook.xml.rels")) {
    const workbookXml = await zip.file("xl/workbook.xml").async("string");
    const workbookRels = parseRelationships(await zip.file("xl/_rels/workbook.xml.rels").async("string"));
    const sheetRefs = [...workbookXml.matchAll(/<sheet\b[^>]*\br:id="([^"]+)"/g)].map((match) => match[1]);
    report.counts.sheets = sheetRefs.length;
    if (!sheetRefs.length) report.issues.push(issue("missing_sheets", "xl/workbook.xml contains no sheet references."));
    for (const relId of sheetRefs) {
      const rel = workbookRels.get(relId);
      if (!rel) {
        report.issues.push(issue("missing_sheet_relationship", `Sheet reference ${relId} has no workbook relationship.`));
        continue;
      }
      const sheetPart = normalizePart("xl", rel.Target || "");
      if (!zip.file(sheetPart)) report.issues.push(issue("missing_sheet_part", `Sheet relationship ${relId} points to missing part ${sheetPart}.`, [sheetPart]));
    }
  }

  for (const sheetPart of Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))) {
    const sheetXml = await zip.file(sheetPart).async("string");
    for (const match of sheetXml.matchAll(/<c\b[^>]*>/g)) {
      const attrs = parseAttrs(match[0]);
      if (attrs.t === "s") {
        const cellEnd = sheetXml.indexOf("</c>", match.index);
        const cellXml = cellEnd === -1 ? "" : sheetXml.slice(match.index, cellEnd + 4);
        const valueMatch = cellXml.match(/<v>(\d+)<\/v>/);
        if (valueMatch && Number(valueMatch[1]) >= sharedStringCount) {
          report.issues.push(issue("shared_string_index_out_of_bounds", `${sheetPart} references shared string index ${valueMatch[1]} but only ${sharedStringCount} shared strings exist.`, [sheetPart]));
        }
      }
      if (attrs.s && cellXfsCount && Number(attrs.s) >= cellXfsCount) {
        report.issues.push(issue("style_index_out_of_bounds", `${sheetPart} uses style index ${attrs.s} but only ${cellXfsCount} cell styles exist.`, [sheetPart]));
      }
    }
    for (const match of sheetXml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)) {
      if (!validRange(match[1])) report.issues.push(issue("invalid_merge_range", `${sheetPart} has invalid merge range ${match[1]}.`, [sheetPart]));
    }
  }

  const mediaFiles = Object.keys(zip.files).filter((name) => /^xl\/media\/[^/]+$/i.test(name));
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
  console.error("Usage: node scripts/validate_xlsx.mjs --input file.xlsx");
  process.exit(2);
}

const report = await validate(args.input);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
