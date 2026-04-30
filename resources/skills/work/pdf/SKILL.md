---
name: pdf
description: Comprehensive PDF manipulation toolkit for extracting text and tables, creating new PDFs, merging/splitting documents, and handling forms. When Claude needs to fill in a PDF form or programmatically process, generate, or analyze PDF documents at scale.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing Guide

## Overview

This guide covers essential PDF processing operations using Python libraries and command-line tools. For advanced features, JavaScript libraries, and detailed examples, see reference.md. If you need to fill out a PDF form, read forms.md and follow its instructions.

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

# Read a PDF
reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = ""
for page in reader.pages:
    text += page.extract_text()
```

## Python Libraries

### pypdf - Basic Operations

#### Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

#### Split PDF
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

#### Extract Metadata
```python
reader = PdfReader("document.pdf")
meta = reader.metadata
print(f"Title: {meta.title}")
print(f"Author: {meta.author}")
print(f"Subject: {meta.subject}")
print(f"Creator: {meta.creator}")
```

#### Rotate Pages
```python
reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]
page.rotate(90)  # Rotate 90 degrees clockwise
writer.add_page(page)

with open("rotated.pdf", "wb") as output:
    writer.write(output)
```

### pdfplumber - Text and Table Extraction

#### Extract Text with Layout
```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

#### Extract Tables
```python
with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"Table {j+1} on page {i+1}:")
            for row in table:
                print(row)
```

#### Advanced Table Extraction
```python
import pandas as pd

with pdfplumber.open("document.pdf") as pdf:
    all_tables = []
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            if table:  # Check if table is not empty
                df = pd.DataFrame(table[1:], columns=table[0])
                all_tables.append(df)

# Combine all tables
if all_tables:
    combined_df = pd.concat(all_tables, ignore_index=True)
    combined_df.to_excel("extracted_tables.xlsx", index=False)
```

### reportlab - Create PDFs

#### Basic PDF Creation
```python
import os
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


def register_cjk_font():
    font_candidates = [
        # Windows
        ("CJK", r"C:\Windows\Fonts\msyh.ttc", 0),
        ("CJK", r"C:\Windows\Fonts\simhei.ttf", 0),
        ("CJK", r"C:\Windows\Fonts\simsun.ttc", 0),
        # macOS
        ("CJK", "/System/Library/Fonts/PingFang.ttc", 0),
        ("CJK", "/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
        # Linux
        ("CJK", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
        ("CJK", "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", 0),
        ("CJK", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
    ]

    for font_name, font_path, subfont_index in font_candidates:
        if os.path.exists(font_path):
            pdfmetrics.registerFont(
                TTFont(font_name, font_path, subfontIndex=subfont_index)
            )
            return font_name, font_path

    raise RuntimeError(
        "No usable CJK font found. Install a font such as Noto Sans CJK first."
    )


font_name, font_path = register_cjk_font()
c = canvas.Canvas("hello.pdf", pagesize=letter)
width, height = letter

# Always switch to the detected CJK font before drawing Chinese text.
c.setFont(font_name, 14)
c.drawString(100, height - 100, "你好，世界")
c.drawString(100, height - 125, f"Using font: {font_path}")
c.drawString(100, height - 150, "This PDF was created with reportlab.")
c.line(100, height - 170, 420, height - 170)
c.save()
```

#### Create PDF with Multiple Pages
```python
import os
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


def register_report_fonts():
    candidates = [
        # Windows
        ("PDF-CJK", "PDF-CJK-Bold", r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc", 0, 0),
        ("PDF-CJK", "PDF-CJK-Bold", r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simhei.ttf", 0, 0),
        # macOS
        ("PDF-CJK", "PDF-CJK-Bold", "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/PingFang.ttc", 0, 0),
        ("PDF-CJK", "PDF-CJK-Bold", "/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc", 0, 0),
        # Linux
        ("PDF-CJK", "PDF-CJK-Bold", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 0, 0),
        ("PDF-CJK", "PDF-CJK-Bold", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0, 0),
    ]

    for regular_name, bold_name, regular_path, bold_path, regular_index, bold_index in candidates:
        if not os.path.exists(regular_path):
            continue

        pdfmetrics.registerFont(
            TTFont(regular_name, regular_path, subfontIndex=regular_index)
        )

        if os.path.exists(bold_path):
            pdfmetrics.registerFont(
                TTFont(bold_name, bold_path, subfontIndex=bold_index)
            )
        else:
            bold_name = regular_name

        return regular_name, bold_name, regular_path, bold_path

    raise RuntimeError(
        "No usable CJK font found. On Linux, install fonts-noto-cjk first."
    )


font_regular, font_bold, regular_path, bold_path = register_report_fonts()
doc = SimpleDocTemplate("report.pdf", pagesize=A4)
styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    "TitleCJK",
    parent=styles["Title"],
    fontName=font_bold,
    fontSize=20,
    leading=24,
    alignment=TA_CENTER,
    textColor=colors.HexColor("#1E6BB8"),
    wordWrap="CJK",
)
body_style = ParagraphStyle(
    "BodyCJK",
    parent=styles["BodyText"],
    fontName=font_regular,
    fontSize=11,
    leading=16,
    wordWrap="CJK",
)
heading_style = ParagraphStyle(
    "HeadingCJK",
    parent=styles["Heading1"],
    fontName=font_bold,
    fontSize=14,
    leading=18,
    wordWrap="CJK",
)

story = [
    Paragraph("年度财务报告", title_style),
    Spacer(1, 12),
    Paragraph(
        f"Detected font: {regular_path}<br/>This template checks system fonts before creating the PDF.",
        body_style,
    ),
    Spacer(1, 12),
    Paragraph("关键指标", heading_style),
]

table = Table(
    [
        ["指标", "金额"],
        ["营业收入", "1,780 亿元"],
        ["净利润", "502 亿元"],
    ],
    colWidths=[6 * cm, 5 * cm],
)
table.setStyle(
    TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1E6BB8")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("FONTNAME", (0, 0), (-1, 0), font_bold),
            ("FONTNAME", (0, 1), (-1, -1), font_regular),
            ("GRID", (0, 0), (-1, -1), 0.8, colors.grey),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]
    )
)
story.append(table)
story.append(PageBreak())
story.append(Paragraph("第二页", heading_style))
story.append(Paragraph("所有段落和表格都显式使用检测到的中文字体。", body_style))

doc.build(story)
```

When generating PDFs with Chinese, never rely on reportlab built-in fonts such as `Helvetica` or `Times-Roman`. Detect a usable CJK font first, register it with `TTFont`, and then assign that font explicitly in every `ParagraphStyle`, `canvas.setFont(...)`, and `TableStyle`.

## Command-Line Tools

### pdftotext (poppler-utils)
```bash
# Extract text
pdftotext input.pdf output.txt

# Extract text preserving layout
pdftotext -layout input.pdf output.txt

# Extract specific pages
pdftotext -f 1 -l 5 input.pdf output.txt  # Pages 1-5
```

### qpdf
```bash
# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
qpdf input.pdf --pages . 6-10 -- pages6-10.pdf

# Rotate pages
qpdf input.pdf output.pdf --rotate=+90:1  # Rotate page 1 by 90 degrees

# Remove password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

### pdftk (if available)
```bash
# Merge
pdftk file1.pdf file2.pdf cat output merged.pdf

# Split
pdftk input.pdf burst

# Rotate
pdftk input.pdf rotate 1east output rotated.pdf
```

## Common Tasks

### Extract Text from Scanned PDFs
```python
# Requires: pip install pytesseract pdf2image
import pytesseract
from pdf2image import convert_from_path

# Convert PDF to images
images = convert_from_path('scanned.pdf')

# OCR each page
text = ""
for i, image in enumerate(images):
    text += f"Page {i+1}:\n"
    text += pytesseract.image_to_string(image)
    text += "\n\n"

print(text)
```

### Add Watermark
```python
from pypdf import PdfReader, PdfWriter

# Create watermark (or load existing)
watermark = PdfReader("watermark.pdf").pages[0]

# Apply to all pages
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as output:
    writer.write(output)
```

### Extract Images
```bash
# Using pdfimages (poppler-utils)
pdfimages -j input.pdf output_prefix

# This extracts all images as output_prefix-000.jpg, output_prefix-001.jpg, etc.
```

### Password Protection
```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

# Add password
writer.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

## Quick Reference

| Task | Best Tool | Command/Code |
|------|-----------|--------------|
| Merge PDFs | pypdf | `writer.add_page(page)` |
| Split PDFs | pypdf | One page per file |
| Extract text | pdfplumber | `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Create PDFs | reportlab | Canvas or Platypus |
| Command line merge | qpdf | `qpdf --empty --pages ...` |
| OCR scanned PDFs | pytesseract | Convert to image first |
| Fill PDF forms | pdf-lib or pypdf (see forms.md) | See forms.md |

## Next Steps

- For advanced pypdfium2 usage, see reference.md
- For JavaScript libraries (pdf-lib), see reference.md
- If you need to fill out a PDF form, follow the instructions in forms.md
- For troubleshooting guides, see reference.md
