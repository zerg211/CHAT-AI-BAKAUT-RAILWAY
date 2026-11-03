"""Read requested facts for exact indexed product IDs in one catalog call.

The caller supplies the existing read-only Knowledge instance.  Keeping the
revision check here prevents mixing facts from different catalog snapshots.
"""

from __future__ import annotations

import re
from typing import Any


_PRODUCT_ID = re.compile(r"[0-9a-f]{24}")
_MAX_PRODUCTS = 100
_MAX_FIELDS = 32
_MAX_FIELD_LENGTH = 200


def get_products_batch(
    knowledge: Any,
    identifiers: list[str],
    fields: list[str],
    expected_revision: str | None = None,
) -> dict[str, Any]:
    """Return exact per-product facts; missing/ambiguous facts remain explicit.

    Only internal product IDs are accepted: human-facing SKU and model strings
    can identify multiple offers and must be resolved by the single-card tool
    before the batch is constructed.  Requests above the limit are rejected,
    never silently truncated.
    """
    revision = knowledge.revision
    if expected_revision is not None and expected_revision != revision:
        raise ValueError("Catalog revision changed; repeat the search")
    if not isinstance(identifiers, list) or not 1 <= len(identifiers) <= _MAX_PRODUCTS:
        raise ValueError("Provide between 1 and 100 exact product IDs")
    if any(not isinstance(item, str) or not _PRODUCT_ID.fullmatch(item) for item in identifiers):
        raise ValueError("Each product identifier must be an exact product ID")
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Duplicate product IDs are not permitted")
    if not isinstance(fields, list) or not 1 <= len(fields) <= _MAX_FIELDS:
        raise ValueError("Provide between 1 and 32 requested fields")
    if any(not isinstance(field, str) or not field.strip() or len(field) > _MAX_FIELD_LENGTH for field in fields):
        raise ValueError("Invalid requested field")
    if len(set(fields)) != len(fields):
        raise ValueError("Duplicate requested fields are not permitted")

    results = []
    for identifier in identifiers:
        product = knowledge.get_product(identifier, fields)
        if not isinstance(product, dict):
            raise ValueError("Invalid catalog response")
        if product.get("status") == "found" and product.get("product_id") != identifier:
            raise ValueError("Catalog returned a different product")
        results.append({"requested_product_id": identifier, **product})

    return {"status": "ok", "source_revision": revision, "results": results}
