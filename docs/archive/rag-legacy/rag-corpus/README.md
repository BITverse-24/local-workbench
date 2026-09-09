# Local RAG corpus metadata

This directory contains the repository-file corpus prepared for the offline
demo. It contains exactly ten source documents: the two existing Flow A seed
documents and eight additional controlled Markdown documents generated for
local testing. Generated here means committed as an ordinary source file;
the corpus does not depend on network retrieval or an external document API.

## Format and size

Documents are Markdown files, normally 1–3 pages equivalent, with stable
section markers in the form `[section:<sectionId>]`. The retrieval unit is one
section. The two Flow A seed documents remain in `../flow-a/` and are referenced
by the manifest rather than copied.

## Index configuration

`corpus-manifest.json` records the stable document names, source paths,
section IDs, excerpts, keywords, content hashes, and local embedding settings.
The intended embedding model is the local `BAAI/bge-small-en-v1.5` model with
384-dimensional normalized vectors and cosine distance. No hosted embedding
API is part of this bundle.

## Query expectations

`queries.json` defines the Flow A retrieval query, supporting retrieval
queries, and a no-match query. The no-match case expects an empty result after
the configured cosine-similarity threshold is applied. Chroma's nearest-neighbor
query alone is not sufficient for this policy because it can return a nearest
document for an unrelated query.

Run the metadata checks with:

```text
python validate_corpus.py
```

The validator checks source existence, stable IDs, section markers, excerpt
integrity, content hashes, document count, query expectations, and the local
embedding contract. It does not create a Chroma index; that requires the local
model weights and the backend's indexing integration.

