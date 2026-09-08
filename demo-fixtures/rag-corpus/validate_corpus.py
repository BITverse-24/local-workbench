"""Validate the local RAG corpus metadata without model or network access."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT.parent


def load(name: str):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate() -> None:
    manifest = load("corpus-manifest.json")
    queries = load("queries.json")
    documents = manifest["documents"]
    check(manifest["documentCount"] == 10, "corpus must contain exactly ten documents")
    check(len(documents) == manifest["documentCount"], "document count does not match manifest")
    check(manifest["sourcePolicy"] == "repository-files-only", "corpus source policy is not local")
    embedding = manifest["embedding"]
    check(embedding["mode"] == "local-transformers", "embedding mode must be local-transformers")
    check(embedding["dimensions"] == 384, "embedding dimension must be 384")
    check(embedding["distanceMetric"] == "cosine", "distance metric must be cosine")
    check(embedding["normalizeEmbeddings"] is True, "embeddings must be normalized")
    check(queries["similarityPolicy"]["minimumSimilarity"] == 0.7, "similarity threshold changed unexpectedly")

    document_ids = set()
    chunk_ids = set()
    for document in documents:
        document_id = document["documentId"]
        check(document_id not in document_ids, f"duplicate document ID: {document_id}")
        document_ids.add(document_id)
        source = FIXTURES / document["sourcePath"]
        check(source.exists(), f"source file is missing: {document['sourcePath']}")
        check(document["sourceFormat"] == "markdown", f"unsupported source format: {document_id}")
        text = source.read_text(encoding="utf-8")
        check(hashlib.sha256(source.read_bytes()).hexdigest() == document["contentSha256"], f"hash mismatch: {document_id}")
        check(re.search(r"^# .+$", text, re.MULTILINE), f"missing title: {document_id}")
        sections = document["sections"]
        check(len(sections) == document["sectionCount"], f"section count mismatch: {document_id}")
        for section in sections:
            section_id = section["sectionId"]
            chunk_id = f"{document_id}:{section_id}"
            check(chunk_id not in chunk_ids, f"duplicate chunk ID: {chunk_id}")
            chunk_ids.add(chunk_id)
            metadata = section["chromaMetadata"]
            check(metadata["documentId"] == document_id, f"metadata document ID mismatch: {chunk_id}")
            check(metadata["sectionId"] == section_id, f"metadata section ID mismatch: {chunk_id}")
            check(metadata["sourcePath"] == document["sourcePath"], f"metadata source path mismatch: {chunk_id}")
            check(metadata["corpusVersion"] == manifest["corpusVersion"], f"metadata corpus version mismatch: {chunk_id}")
            marker = f"## [section:{section_id}] {section['heading']}"
            check(marker in text, f"section marker missing: {chunk_id}")
            check(section["excerpt"] in re.sub(r"\s+", " ", text), f"excerpt missing: {chunk_id}")

    query_ids = set()
    for query in queries["queries"]:
        check(query["queryId"] not in query_ids, f"duplicate query ID: {query['queryId']}")
        query_ids.add(query["queryId"])
        check(query["topK"] <= 5, f"query exceeds top-five policy: {query['queryId']}")
        check(query["expectedOutcome"] in {"matching_sources", "no_matching_source"}, f"invalid outcome: {query['queryId']}")
        for expected in query["expectedIncludes"]:
            check(f"{expected['documentId']}:{expected['sectionId']}" in chunk_ids, f"query points to unknown chunk: {query['queryId']}")

    no_match = [query for query in queries["queries"] if query["expectedOutcome"] == "no_matching_source"]
    check(len(no_match) == 1, "exactly one no-match query is required")
    flow_a = next(query for query in queries["queries"] if query["queryId"] == "flow-a-approval-note")
    check({(item["documentId"], item["sectionId"]) for item in flow_a["expectedIncludes"]} >= {("SOP-114", "3.2"), ("TPL-012", "recommendation")}, "Flow A query expectations are incomplete")


if __name__ == "__main__":
    validate()
    print("RAG corpus metadata validation passed: 10 local documents and 3 query cases.")
