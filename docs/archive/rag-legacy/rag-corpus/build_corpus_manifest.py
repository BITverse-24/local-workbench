"""Build the checked-in metadata manifest for the local RAG corpus."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT.parent
DOCUMENT_SPECS = [
    ("SOP-114", "sop-114-pressure-equipment-inspection", "SOP", "4.0", "Approved", "../flow-a/sop-114-pressure-equipment-inspection.md"),
    ("TPL-012", "approval-note-template-TPL-012", "template", "2.0", "Controlled", "../flow-a/approval-note-template-TPL-012.md"),
    ("SOP-201", "SOP-201-lockout-isolation", "SOP", "3.1", "Approved", "docs/SOP-201-lockout-isolation.md"),
    ("SOP-305", "SOP-305-heat-exchanger-cleaning", "SOP", "2.4", "Approved", "docs/SOP-305-heat-exchanger-cleaning.md"),
    ("SOP-411", "SOP-411-relief-valve-testing", "SOP", "5.0", "Approved", "docs/SOP-411-relief-valve-testing.md"),
    ("SOP-520", "SOP-520-inspection-records", "SOP", "1.8", "Approved", "docs/SOP-520-inspection-records.md"),
    ("SOP-610", "SOP-610-instrument-calibration", "SOP", "2.0", "Approved", "docs/SOP-610-instrument-calibration.md"),
    ("TPL-021", "TPL-021-maintenance-deviation-note", "template", "1.2", "Controlled", "docs/TPL-021-maintenance-deviation-note.md"),
    ("WI-008", "WI-008-tube-retubing", "work-instruction", "3.3", "Approved", "docs/WI-008-tube-retubing.md"),
    ("REF-044", "REF-044-equipment-identifiers", "reference", "1.0", "Controlled", "docs/REF-044-equipment-identifiers.md"),
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def title_from_markdown(text: str) -> str:
    return re.search(r"^# (.+)$", text, re.MULTILINE).group(1)


def sections_from_markdown(text: str) -> list[dict[str, object]]:
    matches = list(re.finditer(r"^## \[section:([^\]]+)\] (.+)$", text, re.MULTILINE))
    sections = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end():end].strip()
        excerpt = re.sub(r"\s+", " ", body)
        sections.append({
            "sectionId": match.group(1),
            "label": f"{match.group(1)} {match.group(2)}",
            "heading": match.group(2),
            "excerpt": excerpt,
            "keywords": re.findall(r"[a-z][a-z-]{3,}", excerpt.lower())[:20],
        })
    return sections


def main() -> None:
    documents = []
    for document_id, stable_name, kind, revision, status, relative_source in DOCUMENT_SPECS:
        source = (ROOT / relative_source).resolve()
        text = source.read_text(encoding="utf-8")
        sections = sections_from_markdown(text)
        title = title_from_markdown(text)
        source_path = str(source.relative_to(FIXTURES)).replace("\\", "/")
        for section in sections:
            section["chromaMetadata"] = {
                "documentId": document_id,
                "sectionId": section["sectionId"],
                "label": f"{document_id} §{section['sectionId']}",
                "documentTitle": title,
                "documentKind": kind,
                "revision": revision,
                "status": status,
                "sourcePath": source_path,
                "corpusVersion": "1.0.0",
            }
        documents.append({
            "documentId": document_id,
            "stableName": stable_name,
            "title": title,
            "kind": kind,
            "revision": revision,
            "status": status,
            "sourcePath": source_path,
            "sourceFormat": "markdown",
            "language": "en",
            "contentSha256": sha256(source),
            "sectionCount": len(sections),
            "sections": sections,
        })

    manifest = {
        "corpusId": "sovereign-workbench-demo",
        "corpusVersion": "1.0.0",
        "sourcePolicy": "repository-files-only",
        "documentCount": len(documents),
        "embedding": {
            "mode": "local-transformers",
            "model": "BAAI/bge-small-en-v1.5",
            "modelPath": "<local-model-dir>/BAAI/bge-small-en-v1.5",
            "dimensions": 384,
            "distanceMetric": "cosine",
            "normalizeEmbeddings": True,
        },
        "chunking": {
            "unit": "section",
            "sectionMarker": "[section:<sectionId>]",
            "stableChunkId": "<documentId>:<sectionId>",
            "overlapCharacters": 0,
        },
        "chromaMetadataFields": [
            "documentId", "sectionId", "label", "documentTitle", "documentKind",
            "revision", "status", "sourcePath", "corpusVersion",
        ],
        "documents": documents,
    }
    (ROOT / "corpus-manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Built corpus manifest for {len(documents)} documents.")


if __name__ == "__main__":
    main()
