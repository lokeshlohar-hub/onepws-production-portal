"""ONEPWS Wood BOM Extractor — Yokogawa horizontal-text template.
Extracts DESCRIPTION, T, QTY, COLOR, L, W from CAD-drawing PDFs.
Emits confidence per field so caller can gate low-confidence sizes."""

import re
import pymupdf
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class ExtractedRow:
    description: str = ""
    length_mm: Optional[float] = None
    width_mm: Optional[float] = None
    thickness_mm: Optional[int] = None
    qty: Optional[int] = None
    color_finish: str = ""
    material_raw: str = ""
    qty_raw: str = ""
    lr_split: str = ""
    confidence: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)


@dataclass
class SheetExtraction:
    source_pdf: str = ""
    page_number: int = 0
    project_no: str = ""
    customer: str = ""
    project_name: str = ""
    drawing_no: str = ""
    sheet_of: str = ""
    rows: list = field(default_factory=list)
    error: str = ""


def _collect_spans(page):
    spans = []
    d = page.get_text("dict")
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            dir_ = line.get("dir", (1.0, 0.0))
            for s in line.get("spans", []):
                text = s.get("text", "").strip()
                if not text:
                    continue
                bx = s["bbox"]
                spans.append({
                    "text": text,
                    "x0": bx[0], "y0": bx[1], "x1": bx[2], "y1": bx[3],
                    "xc": (bx[0] + bx[2]) / 2,
                    "yc": (bx[1] + bx[3]) / 2,
                    "dir": dir_,
                })
    return spans


TITLE_LABELS = {
    "TITLE", "QTY.", "QTY", "MATERIAL", "COLOR", "COLOUR", "FINISH",
    "CUSTOMER NAME", "PROJECT NAME", "PROJECT/WBS NO.", "PROJECT/WBS NO",
    "DRAWING No.", "DRAWING NO.", "DRAWING No", "SHEET",
}
_PLACEHOLDER_RE = re.compile(r"^[\-–—_.\s]*$")

def _is_placeholder(text):
    return bool(_PLACEHOLDER_RE.match(text or ""))

def _norm_label(text):
    return text.strip().rstrip(":").strip().upper()

def _find_label_span(spans, label_variants):
    variants_upper = {v.upper() for v in label_variants}
    for s in spans:
        if _norm_label(s["text"]) in variants_upper:
            return s
    return None

def _value_right_of(spans, label_span, y_tolerance=7.0, max_x_gap=250):
    if not label_span:
        return []
    lb_yc = label_span["yc"]
    lb_x1 = label_span["x1"]
    hits = []
    for s in spans:
        if s is label_span:
            continue
        if abs(s["yc"] - lb_yc) > y_tolerance:
            continue
        if s["x0"] < lb_x1 - 2:
            continue
        if s["x0"] - lb_x1 > max_x_gap:
            continue
        hits.append(s)
    real = [h for h in hits if not _is_placeholder(h["text"])]
    if real:
        hits = real
    hits.sort(key=lambda s: s["x0"])
    return hits

def _multiline_value(spans, first_value_span, line_gap_max=6.0):
    if not first_value_span:
        return ""
    label_ys = set()
    for s in spans:
        if s["text"].endswith(":") or _norm_label(s["text"]) in TITLE_LABELS:
            label_ys.add(round(s["yc"], 0))
    parts = [first_value_span["text"]]
    base_x0 = first_value_span["x0"]
    prev_y1 = first_value_span["y1"]
    candidates = []
    for s in spans:
        if s is first_value_span:
            continue
        if s["y0"] <= prev_y1 - 1:
            continue
        if abs(s["x0"] - base_x0) > 12:
            continue
        candidates.append(s)
    candidates.sort(key=lambda s: s["y0"])
    for s in candidates:
        gap = s["y0"] - prev_y1
        if gap > line_gap_max:
            break
        if round(s["yc"], 0) in label_ys:
            break
        if s["text"].endswith(":"):
            break
        if _is_placeholder(s["text"]):
            break
        parts.append(s["text"])
        prev_y1 = s["y1"]
    return " / ".join(parts).strip()

def _extract_title_field(spans, label_variants, multiline=False):
    label_span = _find_label_span(spans, label_variants)
    if not label_span:
        return ""
    values = _value_right_of(spans, label_span)
    if not values:
        return ""
    if not multiline:
        return values[0]["text"]
    return _multiline_value(spans, values[0])

def _extract_sheet_of(spans):
    label_span = _find_label_span(spans, ["SHEET", "SHEET:"])
    if not label_span:
        return ""
    hits = _value_right_of(spans, label_span, y_tolerance=6.0, max_x_gap=200)
    parts = [h["text"] for h in hits if re.match(r"^(\d+|OF)$", h["text"], re.IGNORECASE)]
    if len(parts) >= 3:
        return f"{parts[0]} OF {parts[2]}"
    return " ".join(parts).strip()

def _extract_all_title_fields(spans):
    return {
        "title":        _extract_title_field(spans, ["TITLE", "TITLE:"]),
        "qty":          _extract_title_field(spans, ["QTY.", "QTY", "QTY:"]),
        "material":     _extract_title_field(spans, ["MATERIAL", "MATERIAL:"]),
        "color":        _extract_title_field(spans, ["COLOR", "COLOR:", "COLOUR"],
                                             multiline=True),
        "customer":     _extract_title_field(spans, ["CUSTOMER NAME", "CUSTOMER NAME:"]),
        "project_name": _extract_title_field(spans, ["PROJECT NAME", "PROJECT NAME:"]),
        "project_no":   _extract_title_field(spans, ["PROJECT/WBS NO.", "PROJECT/WBS NO"]),
        "drawing_no":   _extract_title_field(spans, ["DRAWING No.", "DRAWING NO.", "DRAWING No"]),
        "sheet_of":     _extract_sheet_of(spans),
    }


MATERIAL_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*MM\s+(.+?)\s*$", re.IGNORECASE)
def parse_material(raw):
    if not raw:
        return (None, "")
    m = MATERIAL_RE.match(raw)
    if not m:
        return (None, raw.strip())
    try:
        thk = int(float(m.group(1)))
    except ValueError:
        thk = None
    return (thk, m.group(2).strip())


QTY_SIMPLE_RE = re.compile(r"^\s*(\d+)\s*NOS?\.?\s*$", re.IGNORECASE)
QTY_LR_RE     = re.compile(r"^\s*(\d+)\s*L\s*\+\s*(\d+)\s*R\s*$", re.IGNORECASE)
def parse_qty(raw):
    if not raw:
        return []
    m = QTY_LR_RE.match(raw)
    if m:
        return [(int(m.group(1)), "LHS"), (int(m.group(2)), "RHS")]
    m = QTY_SIMPLE_RE.match(raw)
    if m:
        return [(int(m.group(1)), "")]
    m = re.match(r"^\s*(\d+)\s*$", raw)
    if m:
        return [(int(m.group(1)), "")]
    return []


_PURE_NUM_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*$")
_TOLERANCE_TABLE_VALUES = {0.5, 3, 6, 30, 120, 400, 1000, 2000, 4000, 10, 50}

def _extract_dim_candidates(spans, page_rect):
    w = page_rect.width
    h = page_rect.height
    x_limit = w * 0.75
    y_limit = h * 0.72
    dims = []
    for s in spans:
        if s["x0"] > x_limit or s["y0"] > y_limit:
            continue
        t = s["text"].strip()
        if not t:
            continue
        if t[0] in ("Ø", "R", "±") or "°" in t or "'" in t:
            continue
        m = _PURE_NUM_RE.match(t)
        if not m:
            continue
        try:
            val = float(m.group(1))
        except ValueError:
            continue
        if val < 15 or val > 3000:
            continue
        if val in _TOLERANCE_TABLE_VALUES:
            continue
        dims.append({"val": val, "x": s["xc"], "y": s["yc"], "text": t, "dir": s["dir"]})
    return dims

def _detect_coordinate_columns(dims, x_tolerance=10, min_group_size=4):
    excluded_from_L = set()
    buckets = {}
    for i, d in enumerate(dims):
        dx, dy = d["dir"]
        if abs(dx) < 0.7:
            continue
        key = round(d["x"] / x_tolerance) * x_tolerance
        buckets.setdefault(key, []).append(i)
    for key, indices in buckets.items():
        if len(indices) < min_group_size:
            continue
        ys = [dims[i]["y"] for i in indices]
        if max(ys) - min(ys) < 40:
            continue
        excluded_from_L.update(indices)
    return excluded_from_L

def infer_overall_size(spans, page_rect):
    """Returns (L, W, note, confidence_level)."""
    dims = _extract_dim_candidates(spans, page_rect)
    if not dims:
        return (None, None, "no dimensions found", "low")

    coord_col_ids = _detect_coordinate_columns(dims)
    non_coord = [d for i, d in enumerate(dims) if i not in coord_col_ids]
    if len(non_coord) < 2:
        non_coord = dims

    xs = [d["x"] for d in non_coord]
    ys = [d["y"] for d in non_coord]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    x_span = max(x_max - x_min, 1)
    y_span = max(y_max - y_min, 1)

    edge_frac = 0.18
    top_zone    = y_min + edge_frac * y_span
    bottom_zone = y_max - edge_frac * y_span
    left_zone   = x_min + edge_frac * x_span
    right_zone  = x_max - edge_frac * x_span

    horiz_edge_vals = []
    vert_edge_vals  = []
    used_coord_col_for_W = False

    for i, d in enumerate(dims):
        in_coord_col = i in coord_col_ids
        if in_coord_col:
            vert_edge_vals.append(d["val"])
            used_coord_col_for_W = True
            continue
        near_horiz_edge = d["y"] <= top_zone   or d["y"] >= bottom_zone
        near_vert_edge  = d["x"] <= left_zone  or d["x"] >= right_zone
        if near_horiz_edge and not near_vert_edge:
            horiz_edge_vals.append(d["val"])
        elif near_vert_edge and not near_horiz_edge:
            vert_edge_vals.append(d["val"])
        elif near_horiz_edge and near_vert_edge:
            dx, dy = d["dir"]
            if abs(dx) > 0.7:
                horiz_edge_vals.append(d["val"])
            elif abs(dy) > 0.7:
                vert_edge_vals.append(d["val"])

    x_extent = max(horiz_edge_vals, default=None)
    y_extent = max(vert_edge_vals,  default=None)

    if x_extent is None and y_extent is None:
        values = sorted({d["val"] for d in dims}, reverse=True)
        if len(values) < 2:
            return (values[0] if values else None, None, "fallback: single dim", "low")
        return (round(values[0], 1), round(values[1], 1), "fallback: top-2", "low")

    if x_extent is None:
        return (round(y_extent, 1), None, "no horizontal dim found", "low")
    if y_extent is None:
        return (round(x_extent, 1), None, "no vertical dim found", "low")

    L = round(max(x_extent, y_extent), 1)
    W = round(min(x_extent, y_extent), 1)

    # Confidence gating
    if L == W:
        confidence = "low"     # suspicious equal
        note = "L=W (suspicious, blanked)"
        L, W = None, None
    elif used_coord_col_for_W and W == max((d["val"] for i,d in enumerate(dims) if i in coord_col_ids), default=0):
        confidence = "medium"  # W came from coord column
        note = "W from coordinate column"
    else:
        confidence = "high"
        note = "ok"

    return (L, W, note, confidence)


def extract_page(pdf_doc, page_index, source_pdf_name):
    page = pdf_doc[page_index]
    spans = _collect_spans(page)
    result = SheetExtraction(source_pdf=source_pdf_name, page_number=page_index + 1)

    try:
        raw = _extract_all_title_fields(spans)
    except Exception as e:
        result.error = f"title-block extraction failed: {e}"
        return result

    result.project_no   = raw.get("project_no", "")
    result.customer     = raw.get("customer", "")
    result.project_name = raw.get("project_name", "")
    result.drawing_no   = raw.get("drawing_no", "")
    result.sheet_of     = raw.get("sheet_of", "")

    title     = raw.get("title", "")
    material  = raw.get("material", "")
    color     = raw.get("color", "")
    qty_raw   = raw.get("qty", "")

    thickness, mat_type = parse_material(material)
    qty_specs = parse_qty(qty_raw)
    if not qty_specs:
        qty_specs = [(None, "")]

    L, W, size_note, size_conf = infer_overall_size(spans, page.rect)

    for qty_int, lr in qty_specs:
        desc = title
        if lr and lr not in title.upper():
            desc = f"{title} - {lr}"

        row = ExtractedRow(
            description=desc,
            length_mm=L,
            width_mm=W,
            thickness_mm=thickness,
            qty=qty_int,
            color_finish=color,
            material_raw=material,
            qty_raw=qty_raw,
            lr_split=lr,
        )
        row.confidence = {
            "description": "high" if title else "low",
            "material":    "high" if thickness is not None else ("medium" if material else "low"),
            "qty":         "high" if qty_int is not None else "low",
            "color":       "high" if color else "empty",
            "size":        size_conf,
        }
        if size_note != "ok":
            row.warnings.append(f"size: {size_note}")
        if qty_int is None:
            row.warnings.append(f"could not parse QTY '{qty_raw}'")
        if thickness is None and material:
            row.warnings.append(f"could not parse thickness from '{material}'")

        result.rows.append(row)

    return result


def extract_pdf_file(pdf_path):
    pdf = pymupdf.open(pdf_path)
    source_name = Path(pdf_path).name
    return [asdict(extract_page(pdf, i, source_name)) for i in range(pdf.page_count)]