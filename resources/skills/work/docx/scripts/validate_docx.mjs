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
  const args = { input: null, repairOutput: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--repair-output") args.repairOutput = argv[++i];
    else if (!arg.startsWith("--") && !args.input) args.input = arg;
  }
  return args;
}

function issue(code, message, count = 1, severity = "error") {
  return { code, severity, count, message };
}

function parseAttrs(tag) {
  const attrs = {};
  const rx = /([\w:.-]+)="([^"]*)"/g;
  let match;
  while ((match = rx.exec(tag))) attrs[match[1]] = match[2];
  return attrs;
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

function getBodyInner(documentXml) {
  const match = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  return match ? match[1] : null;
}

function isWhitespace(text) {
  return /^[\s\r\n\t]*$/.test(text);
}

function tagName(tag) {
  const match = tag.match(/^<\s*\/?\s*([A-Za-z0-9_:.-]+)/);
  return match ? match[1] : null;
}

function isClosing(tag) {
  return /^<\s*\//.test(tag);
}

function isSelfClosing(tag) {
  return /\/\s*>$/.test(tag) || /^<\?/.test(tag) || /^<!--/.test(tag);
}

function parseTopLevelElements(xml) {
  const items = [];
  let pos = 0;

  while (pos < xml.length) {
    const start = xml.indexOf("<", pos);
    if (start === -1) break;
    if (!isWhitespace(xml.slice(pos, start))) {
      items.push({ name: "#text", start: pos, end: start, xml: xml.slice(pos, start) });
    }

    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }

    const firstEnd = xml.indexOf(">", start);
    if (firstEnd === -1) break;
    const firstTag = xml.slice(start, firstEnd + 1);
    const name = tagName(firstTag);
    if (!name || isClosing(firstTag)) {
      pos = firstEnd + 1;
      continue;
    }

    if (isSelfClosing(firstTag)) {
      items.push({ name, start, end: firstEnd + 1, xml: firstTag });
      pos = firstEnd + 1;
      continue;
    }

    let depth = 1;
    let search = firstEnd + 1;
    let end = firstEnd + 1;
    while (depth > 0 && search < xml.length) {
      const tagStart = xml.indexOf("<", search);
      if (tagStart === -1) break;
      if (xml.startsWith("<!--", tagStart)) {
        const commentEnd = xml.indexOf("-->", tagStart);
        if (commentEnd === -1) break;
        search = commentEnd + 3;
        continue;
      }
      const tagEnd = xml.indexOf(">", tagStart);
      if (tagEnd === -1) break;
      const tag = xml.slice(tagStart, tagEnd + 1);
      if (!/^<\?/.test(tag) && !isSelfClosing(tag)) {
        depth += isClosing(tag) ? -1 : 1;
      }
      end = tagEnd + 1;
      search = tagEnd + 1;
    }

    items.push({ name, start, end, xml: xml.slice(start, end) });
    pos = end;
  }

  return items;
}

function repairBodyRuns(documentXml) {
  return documentXml.replace(/(<w:body\b[^>]*>)([\s\S]*?)(<\/w:body>)/, (_m, open, inner, close) => {
    const items = parseTopLevelElements(inner);
    if (!items.some((item) => item.name === "w:r")) return `${open}${inner}${close}`;

    let rebuilt = "";
    let pos = 0;
    for (const item of items) {
      rebuilt += inner.slice(pos, item.start);
      rebuilt += item.name === "w:r" ? `<w:p>${item.xml}</w:p>` : item.xml;
      pos = item.end;
    }
    rebuilt += inner.slice(pos);
    return `${open}${rebuilt}${close}`;
  });
}

function renumberIds(xml, tagName, startAt) {
  let nextId = startAt;
  const rx = new RegExp(`(<${tagName}\\b[^>]*\\bid=")\\d+("[^>]*>)`, "g");
  return xml.replace(rx, (_m, before, after) => `${before}${nextId++}${after}`);
}

function parseRelationships(relsXml) {
  const rels = new Map();
  const rx = /<Relationship\b[^>]*>/g;
  let match;
  while ((match = rx.exec(relsXml))) {
    const attrs = parseAttrs(match[0]);
    if (attrs.Id) rels.set(attrs.Id, attrs);
  }
  return rels;
}

function normalizePart(baseDir, target) {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  return path.posix.normalize(path.posix.join(baseDir, target)).replace(/\\/g, "/");
}

function relationshipBaseDir(relsPartName) {
  if (relsPartName === "_rels/.rels") return "";
  return relsPartName.replace(/_rels\/[^/]+\.rels$/i, "");
}

function runProps() {
  return [
    '<w:rPr>',
    '<w:rFonts w:ascii="Microsoft YaHei" w:cs="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei"/>',
    '<w:sz w:val="18"/>',
    '<w:szCs w:val="18"/>',
    '</w:rPr>',
  ].join("");
}

function pageFieldRuns(name, previewValue = "1") {
  const props = runProps();
  return [
    `<w:r>${props}<w:fldChar w:fldCharType="begin"/></w:r>`,
    `<w:r>${props}<w:instrText xml:space="preserve"> ${name} </w:instrText></w:r>`,
    `<w:r>${props}<w:fldChar w:fldCharType="separate"/></w:r>`,
    `<w:r>${props}<w:t>${previewValue}</w:t></w:r>`,
    `<w:r>${props}<w:fldChar w:fldCharType="end"/></w:r>`,
  ].join("");
}

function repairBarePageNumberText(xml) {
  const pageNumberRuns = [
    pageFieldRuns("PAGE"),
    `<w:r>${runProps()}<w:t xml:space="preserve"> / </w:t></w:r>`,
    pageFieldRuns("NUMPAGES"),
  ].join("");

  return xml
    .replace(
      /<w:r><w:rPr>[\s\S]*?<\/w:rPr><text>PAGE<\/text><text>NUMPAGES<\/text><\/w:r>/g,
      pageNumberRuns,
    )
    .replace(/<text>([^<]*)<\/text>/g, '<w:t xml:space="preserve">$1</w:t>');
}

function collectUnqualifiedTags(xml) {
  const names = [];
  const rx = /<\s*\/?\s*([A-Za-z][A-Za-z0-9.-]*)(?=[\s>/])/g;
  let match;
  while ((match = rx.exec(xml))) {
    const name = match[1];
    if (name !== "xml") names.push(name);
  }
  return names;
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
  }).parseFromString(xml, partName.endsWith(".rels") ? "application/xml" : "text/xml");
  return errors;
}

async function validateBuffer(buffer) {
  const report = {
    ok: false,
    issues: [],
    counts: {
      embeddedImages: 0,
      mediaFiles: 0,
      relationshipTargetsChecked: 0,
      topLevelBodyRuns: 0,
      topLevelPageBreakRuns: 0,
      xmlPartsChecked: 0,
    },
  };

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    report.issues.push(issue("invalid_zip", `DOCX is not a readable zip package: ${error.message}`));
    return { report, zip: null, documentXml: null };
  }

  const requiredParts = ["[Content_Types].xml", "word/document.xml", "word/_rels/document.xml.rels"];
  for (const part of requiredParts) {
    if (!zip.file(part)) report.issues.push(issue("missing_part", `Missing required DOCX part: ${part}`));
  }
  if (!zip.file("word/document.xml")) return { report, zip, documentXml: null };

  const xmlPartNames = Object.keys(zip.files).filter((name) => /\.(xml|rels)$/i.test(name) && !zip.files[name].dir);
  report.counts.xmlPartsChecked = xmlPartNames.length;
  for (const name of xmlPartNames) {
    const xml = await zip.file(name).async("string");
    const errors = parseXmlIssues(name, xml);
    if (errors.length) {
      report.issues.push(issue("invalid_xml", `${name} is not well-formed XML: ${errors[0]}`, errors.length));
    }
  }
  if (!DOMParser) {
    report.issues.push(issue(
      "xml_parser_unavailable",
      "XML well-formedness check skipped because @xmldom/xmldom is not installed.",
      1,
      "warning",
    ));
  }

  for (const name of xmlPartNames.filter((part) => /^word\/.*\.xml$/i.test(part))) {
    const xml = await zip.file(name).async("string");
    const unqualifiedTags = collectUnqualifiedTags(xml);
    if (unqualifiedTags.length) {
      const unique = [...new Set(unqualifiedTags)].join(", ");
      report.issues.push(issue(
        "unqualified_word_xml_tag",
        `${name} contains unqualified XML tags (${unique}); WordprocessingML tags should use explicit namespaces such as w:t, w:fldChar, or a:* drawing tags.`,
        unqualifiedTags.length,
      ));
    }
  }

  for (const relsPartName of Object.keys(zip.files).filter((name) => name.endsWith(".rels") && !zip.files[name].dir)) {
    const baseDir = relationshipBaseDir(relsPartName);
    const rels = parseRelationships(await zip.file(relsPartName).async("string"));
    for (const rel of rels.values()) {
      if (rel.TargetMode === "External") continue;
      report.counts.relationshipTargetsChecked += 1;
      const target = normalizePart(baseDir, rel.Target || "");
      if (!zip.file(target)) {
        report.issues.push(issue("missing_relationship_target", `${relsPartName} relationship ${rel.Id} points to missing part ${target}.`));
      }
    }
  }

  const documentXml = await zip.file("word/document.xml").async("string");
  const relsXml = zip.file("word/_rels/document.xml.rels")
    ? await zip.file("word/_rels/document.xml.rels").async("string")
    : "";
  const bodyInner = getBodyInner(documentXml);

  if (!bodyInner) {
    report.issues.push(issue("missing_body", "word/document.xml does not contain w:body."));
  } else {
    const topLevel = parseTopLevelElements(bodyInner);
    const bodyRuns = topLevel.filter((item) => item.name === "w:r");
    const pageBreakRuns = bodyRuns.filter((item) => /<w:br\b[^>]*w:type="page"/.test(item.xml));
    report.counts.topLevelBodyRuns = bodyRuns.length;
    report.counts.topLevelPageBreakRuns = pageBreakRuns.length;
    if (bodyRuns.length) {
      report.issues.push(issue(
        "direct_body_run",
        "word/document.xml contains w:r directly under w:body; wrap runs in w:p paragraphs.",
        bodyRuns.length,
      ));
    }
    if (pageBreakRuns.length) {
      report.issues.push(issue(
        "bare_page_break",
        "Page breaks appear as bare runs under w:body; use new Paragraph({ children: [new PageBreak()] }).",
        pageBreakRuns.length,
      ));
    }
  }

  const wordXml = (await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^word\/.*\.xml$/i.test(name) && !zip.files[name].dir)
      .map((name) => zip.file(name).async("string")),
  )).join("\n");

  const docPrDuplicates = duplicateCount(collectIds(wordXml, "wp:docPr"));
  if (docPrDuplicates) {
    report.issues.push(issue("duplicate_wp_docPr_id", "Duplicate wp:docPr drawing ids found.", docPrDuplicates));
  }
  const cNvPrDuplicates = duplicateCount(collectIds(wordXml, "pic:cNvPr"));
  if (cNvPrDuplicates) {
    report.issues.push(issue("duplicate_pic_cNvPr_id", "Duplicate pic:cNvPr picture ids found.", cNvPrDuplicates));
  }

  const rels = parseRelationships(relsXml);
  const embeds = [...documentXml.matchAll(/\br:embed="([^"]+)"/g)].map((m) => m[1]);
  report.counts.embeddedImages = embeds.length;
  for (const relId of embeds) {
    const rel = rels.get(relId);
    if (!rel) {
      report.issues.push(issue("missing_image_relationship", `Missing image relationship for ${relId}.`));
      continue;
    }
    if (rel.TargetMode === "External") continue;
    const part = normalizePart("word", rel.Target || "");
    if (!zip.file(part)) {
      report.issues.push(issue("missing_image_target", `Image relationship ${relId} points to missing part ${part}.`));
    }
  }

  const mediaFiles = Object.keys(zip.files).filter((name) => /^word\/media\/[^/]+$/i.test(name));
  report.counts.mediaFiles = mediaFiles.length;
  for (const name of mediaFiles) {
    const data = await zip.file(name).async("nodebuffer");
    const ext = path.extname(name).toLowerCase();
    if (ext === ".png" && !data.slice(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      report.issues.push(issue("invalid_png", `Embedded PNG has an invalid signature: ${name}`));
    }
    if ((ext === ".jpg" || ext === ".jpeg") && !(data[0] === 0xff && data[1] === 0xd8)) {
      report.issues.push(issue("invalid_jpeg", `Embedded JPEG has an invalid signature: ${name}`));
    }
    if (ext === ".svg" && !/<svg[\s>]/i.test(data.toString("utf8").slice(0, 1024))) {
      report.issues.push(issue("invalid_svg", `Embedded SVG does not look like SVG XML: ${name}`));
    }
  }

  report.ok = !report.issues.some((item) => item.severity === "error");
  return { report, zip, documentXml };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error("Usage: node validate_docx.mjs --input file.docx [--repair-output repaired.docx]");
    process.exit(2);
  }

  const inputBuffer = fs.readFileSync(args.input);
  const initial = await validateBuffer(inputBuffer);
  const output = { input: args.input, initial: initial.report };

  if (args.repairOutput && initial.zip && initial.documentXml) {
    let documentXml = repairBodyRuns(initial.documentXml);
    documentXml = renumberIds(documentXml, "wp:docPr", 1);
    documentXml = renumberIds(documentXml, "pic:cNvPr", 1);
    initial.zip.file("word/document.xml", documentXml);
    for (const name of Object.keys(initial.zip.files).filter((part) => /^word\/footer\d+\.xml$/i.test(part))) {
      const footerXml = await initial.zip.file(name).async("string");
      initial.zip.file(name, repairBarePageNumberText(footerXml));
    }
    const repairedBuffer = await initial.zip.generateAsync({ type: "nodebuffer" });
    fs.mkdirSync(path.dirname(path.resolve(args.repairOutput)), { recursive: true });
    fs.writeFileSync(args.repairOutput, repairedBuffer);
    const repaired = await validateBuffer(repairedBuffer);
    output.repairOutput = args.repairOutput;
    output.repaired = repaired.report;
  }

  console.log(JSON.stringify(output, null, 2));

  const finalReport = output.repaired || output.initial;
  process.exit(finalReport.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
