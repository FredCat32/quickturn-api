import sys
import json
from docling.document_converter import DocumentConverter

def parse_pdf(pdf_path):
    converter = DocumentConverter()
    result = converter.convert(pdf_path)
    markdown = result.document.export_to_markdown()
    return markdown

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No PDF path provided"}))
        sys.exit(1)

    pdf_path = sys.argv[1]

    try:
        markdown = parse_pdf(pdf_path)
        print(json.dumps({"markdown": markdown}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
