#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate bid-writer deliverables before final answer."""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


PLACEHOLDER_RE = re.compile(r"\[待补充[^\]]*\]|待补充|待核实|占位|TBD|TODO|xxxx|XXXX")
PRICE_RE = re.compile(r"报价|投标总价|开标一览|分项报价|价格")
PERSONNEL_RE = re.compile(r"项目实施人员|项目团队|人员一览|项目经理|项目负责人")
APPENDIX_IMAGE_DUMP_RE = re.compile(
    r"\u9644\u5f55[\uff1a:]\s*\u4f01\u4e1a\u8d44\u6599\u56fe\u7247|"
    r"\u9644\u4ef6[\uff1a:]\s*\u4f01\u4e1a\u8d44\u6599\u56fe\u7247|"
    r"\u4f01\u4e1a\u8d44\u6599\u56fe\u7247|"
    r"appendix\s*[:\uff1a]?\s*(?:company|enterprise|material).*image|"
    r"remaining\s+images|all\s+remaining\s+images",
    re.I,
)
GENERIC_IMAGE_CAPTION_RE = re.compile(
    r"\u8bc1\u636e\u56fe\u7247\s*[:\uff1a]|"
    r"\u672c\u9875\u4e3a\u4e0e\u672c\u8282\u5185\u5bb9\u5bf9\u5e94\u7684"
    r"\u4f01\u4e1a\u8d44\u6599\u8bc1\u660e\u56fe\u7247|"
    r"\u4f01\u4e1a\u8d44\u6599\u8bc1\u660e\u56fe\u7247",
    re.I,
)
TEMPLATE_MARKER_RE = re.compile(
    r"file_type:\s*reference_template|"
    r"is_deliverable:\s*false|"
    r"\u672c\u6587\u4ef6\u662f\s*`?bid-writer`?\s*"
    r"\u7684\u53c2\u8003\u6a21\u677f\u5e93|"
    r"\u4f7f\u7528\u8fb9\u754c|"
    r"\u6a21\u677f\u9009\u62e9|"
    r"\u4e0d\u8fdb\u5165\u4ea4\u4ed8\u7269\u7684\u5185\u5bb9|"
    r"\{\s*\u8bc1\u636e\u69fd\s*[:\uff1a][^{}]{0,120}\}|"
    r"\{[^{}\n]{1,80}\}",
    re.I,
)


def qname(tag: str) -> str:
    return f"{{http://schemas.openxmlformats.org/wordprocessingml/2006/main}}{tag}"


def text_from_xml(root: ET.Element) -> str:
    return "\n".join(node.text or "" for node in root.iter(qname("t")))


def docx_metrics(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
        rels = ET.fromstring(archive.read("word/_rels/document.xml.rels")) if "word/_rels/document.xml.rels" in archive.namelist() else None
    text = text_from_xml(document)
    paragraphs = list(document.iter(qname("p")))
    heading_count = 0
    page_break_before_count = 0
    manual_page_break_count = 0
    toc_field_count = 0
    for paragraph in paragraphs:
        ppr = paragraph.find(qname("pPr"))
        if ppr is not None:
            pstyle = ppr.find(qname("pStyle"))
            style_value = pstyle.attrib.get(qname("val"), "") if pstyle is not None else ""
            if style_value.lower().startswith("heading") or style_value.startswith("标题"):
                heading_count += 1
            if ppr.find(qname("pageBreakBefore")) is not None:
                page_break_before_count += 1
        for br in paragraph.iter(qname("br")):
            if br.attrib.get(qname("type")) == "page":
                manual_page_break_count += 1
        for instr in paragraph.iter(qname("instrText")):
            if "TOC" in (instr.text or ""):
                toc_field_count += 1
    tables = list(document.iter(qname("tbl")))
    drawings = list(document.iter(qname("drawing"))) + list(document.iter(qname("pict")))
    rel_images = []
    if rels is not None:
        for rel in rels:
            target = rel.attrib.get("Target", "")
            rel_type = rel.attrib.get("Type", "")
            if "image" in rel_type.lower() or target.lower().startswith("media/"):
                rel_images.append(target)
    return {
        "text": text,
        "char_count": len(text),
        "heading_count": heading_count,
        "toc_field_count": toc_field_count,
        "table_count": len(tables),
        "drawing_count": len(drawings),
        "embedded_image_count": len(set(rel_images)) or len(drawings),
        "manual_page_break_count": manual_page_break_count,
        "page_break_before_count": page_break_before_count,
    }


def markdown_metrics(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return {
        "text": text,
        "char_count": len(text),
        "heading_count": len(re.findall(r"^#{1,6}\s+\S", text, re.M)),
        "toc_field_count": 0,
        "table_count": len(re.findall(r"^\|.+\|$", text, re.M)),
        "drawing_count": len(re.findall(r"!\[[^\]]*\]\([^)]+\)", text)),
        "embedded_image_count": len(re.findall(r"!\[[^\]]*\]\([^)]+\)", text)),
        "manual_page_break_count": len(re.findall(r"分页符|PageBreak", text)),
        "page_break_before_count": len(re.findall(r"page_break_before|段前分页", text)),
    }


def load_material_image_count(path: str | None) -> int | None:
    if not path:
        return None
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    summary = data.get("summary") or {}
    value = summary.get("image_files")
    return int(value) if isinstance(value, int) else None


def add_issue(issues: list[dict[str, str]], severity: str, code: str, message: str) -> None:
    issues.append({"severity": severity, "code": code, "message": message})


def validate(metrics: dict[str, Any], materials_image_count: int | None) -> tuple[str, list[dict[str, str]]]:
    text = metrics["text"]
    issues: list[dict[str, str]] = []
    if PLACEHOLDER_RE.search(text):
        add_issue(issues, "blocker", "placeholder", "Deliverable contains placeholder text such as 待补充/占位/xxxx.")
    if TEMPLATE_MARKER_RE.search(text):
        add_issue(
            issues,
            "blocker",
            "template_marker",
            "Deliverable contains reference-template markers or unreplaced template variables/evidence slots.",
        )
    if metrics["heading_count"] == 0:
        add_issue(issues, "blocker", "headings", "No real headings detected.")
    if metrics["toc_field_count"] == 0:
        add_issue(issues, "draft", "toc", "No real Word TOC field detected. Markdown outputs cannot satisfy final DOCX TOC requirements.")
    if metrics["manual_page_break_count"] > 0:
        add_issue(issues, "draft", "manual_page_break", "Manual page breaks detected; use paragraph page_break_before for bid section starts.")
    if PRICE_RE.search(text) and PLACEHOLDER_RE.search(text):
        add_issue(issues, "blocker", "quotation_placeholder", "Quotation-related content contains placeholders.")
    if PERSONNEL_RE.search(text) and metrics["embedded_image_count"] == 0:
        add_issue(issues, "draft", "personnel_evidence", "Personnel section appears without embedded evidence images.")
    if metrics["embedded_image_count"] > 0 and APPENDIX_IMAGE_DUMP_RE.search(text):
        add_issue(
            issues,
            "blocker",
            "appendix_image_dump",
            "Company material images appear to be grouped in a generic appendix/attachment section; map evidence images into matching body sections instead.",
        )
    if GENERIC_IMAGE_CAPTION_RE.search(text):
        add_issue(
            issues,
            "blocker",
            "generic_image_caption",
            "Evidence image headings/captions use generic filename boilerplate; write section-specific titles and captions tied to the bid response.",
        )
    if metrics["embedded_image_count"] > 0 and metrics["page_break_before_count"] < metrics["embedded_image_count"]:
        add_issue(
            issues,
            "draft",
            "image_page_blocks",
            "Embedded images may not each start on a dedicated page with heading/caption; expected page_break_before image blocks.",
        )
    if materials_image_count is not None and materials_image_count > 0:
        embedded = int(metrics["embedded_image_count"])
        if embedded == 0:
            add_issue(issues, "blocker", "images_missing", f"Material inventory has {materials_image_count} image files but deliverable has no embedded images.")
        elif embedded < materials_image_count:
            add_issue(issues, "draft", "images_incomplete", f"Embedded images ({embedded}) are fewer than inventoried material images ({materials_image_count}).")
    if metrics["char_count"] < 3000:
        add_issue(issues, "draft", "too_short", "Deliverable text is very short for a full bid.")
    severities = {issue["severity"] for issue in issues}
    if "blocker" in severities:
        return "BLOCKED", issues
    if "draft" in severities:
        return "DRAFT", issues
    return "PASS", issues


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate a generated bid package.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--docx", help="DOCX file to validate.")
    source.add_argument("--markdown", help="Markdown/text file to validate.")
    parser.add_argument("--materials-json", help="Optional material inventory JSON.")
    parser.add_argument("--out", help="Optional JSON report path.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    target = Path(args.docx or args.markdown)
    metrics = docx_metrics(target) if args.docx else markdown_metrics(target)
    materials_image_count = load_material_image_count(args.materials_json)
    status, issues = validate(metrics, materials_image_count)
    report = {
        "schema": "bid-writer.validation.v1",
        "target": str(target),
        "status": status,
        "metrics": {key: value for key, value in metrics.items() if key != "text"},
        "issues": issues,
    }
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if status == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
