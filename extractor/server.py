"""Flask API wrapping the extractor. Localhost-only in production."""
import os
import tempfile
import logging
from flask import Flask, request, jsonify
from extractor import extract_pdf_file

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB per upload

# Log to file for NSSM
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("extractor")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "onepws-extractor", "version": "1.0.0"})


@app.route("/extract", methods=["POST"])
def extract():
    if "file" not in request.files:
        return jsonify({"error": "no file uploaded (expected multipart field: file)"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "empty filename"}), 400
    if not f.filename.lower().endswith(".pdf"):
        return jsonify({"error": "only .pdf accepted"}), 400

    # Save to temp file so pymupdf can open by path
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
    try:
        f.save(tmp.name)
        tmp.close()
        log.info(f"Extracting: {f.filename} ({os.path.getsize(tmp.name)} bytes)")
        pages = extract_pdf_file(tmp.name)
        # Overwrite source_pdf with the original filename (not the temp name)
        for p in pages:
            p["source_pdf"] = f.filename
        total_rows = sum(len(p["rows"]) for p in pages)
        log.info(f"  -> {len(pages)} pages, {total_rows} rows")
        return jsonify({"pages": pages, "row_count": total_rows})
    except Exception as e:
        log.exception("extraction failed")
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


if __name__ == "__main__":
    # Bind to localhost only. NEVER expose this to the LAN.
    app.run(host="127.0.0.1", port=8082, debug=False)