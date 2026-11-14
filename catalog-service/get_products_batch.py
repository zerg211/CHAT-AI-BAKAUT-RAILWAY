"""Read requested facts for exact indexed product IDs in one catalog call.

The caller supplies the existing read-only Knowledge instance.  Keeping the
revision check here prevents mixing facts from different catalog snapshots.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any


_PRODUCT_ID = re.compile(r"[0-9a-f]{24}")
_MAX_PRODUCTS = 100
_MAX_FIELDS = 32
_MAX_FIELD_LENGTH = 200


def get_products_batch(
    knowledge: Any,
    identifiers: list[str],
    fields: list[str] | None = None,
    expected_revision: str | None = None,
    mode: str = 'projection',
    cursor: str | None = None,
) -> dict[str, Any]:
    """Return exact per-product facts; missing/ambiguous facts remain explicit.

    Only internal product IDs are accepted: human-facing SKU and model strings
    can identify multiple offers and must be resolved by the single-card tool
    before the batch is constructed.  Requests above the limit are rejected,
    never silently truncated.
    """
    revision = knowledge.revision
    if mode not in ('projection', 'full'):
        raise ValueError('Invalid product read mode')
    if expected_revision is not None and expected_revision != revision:
        raise ValueError("Catalog revision changed; repeat the search")
    if not isinstance(identifiers, list) or not identifiers or (mode == 'projection' and len(identifiers) > _MAX_PRODUCTS):
        raise ValueError('Provide exact product IDs; projections accept at most 100 per request')
    if any(not isinstance(item, str) or not _PRODUCT_ID.fullmatch(item) for item in identifiers):
        raise ValueError("Each product identifier must be an exact product ID")
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Duplicate product IDs are not permitted")
    if mode == 'full' and fields is not None:
        raise ValueError('Full product reading does not accept a field projection')
    if mode == 'projection' and (not isinstance(fields, list) or not 1 <= len(fields) <= _MAX_FIELDS):
        raise ValueError("Provide between 1 and 32 requested fields")
    if fields is not None and any(not isinstance(field, str) or not field.strip() or len(field) > _MAX_FIELD_LENGTH for field in fields):
        raise ValueError("Invalid requested field")
    if fields is not None and len(set(fields)) != len(fields):
        raise ValueError("Duplicate requested fields are not permitted")

    offset = 0
    fingerprint = hashlib.sha256(json.dumps([revision, identifiers], separators=(',', ':')).encode()).hexdigest()
    if cursor is not None:
        if mode != 'full' or not isinstance(cursor, str) or len(cursor) > 2000:
            raise ValueError('Invalid full product cursor')
        try:
            token = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
            offset = token['offset']
            if token != {'version': 1, 'revision': revision, 'fingerprint': fingerprint, 'offset': offset} or \
                    type(offset) is not int or offset < _MAX_PRODUCTS or offset % _MAX_PRODUCTS or offset >= len(identifiers):
                raise ValueError('Invalid full product cursor')
        except (ValueError, KeyError, TypeError, UnicodeDecodeError) as error:
            raise ValueError('Invalid full product cursor or catalog revision changed') from error

    results = []
    page_ids = identifiers[offset:offset + _MAX_PRODUCTS] if mode == 'full' else identifiers
    for identifier in page_ids:
        product = knowledge.get_product(identifier, fields)
        if not isinstance(product, dict):
            raise ValueError("Invalid catalog response")
        if mode == 'full' and product.get('status') != 'found':
            raise ValueError('Full product not found in the requested catalog revision')
        if product.get("status") == "found" and product.get("product_id") != identifier:
            raise ValueError("Catalog returned a different product")
        results.append({"requested_product_id": identifier, **product})

    if mode == 'projection':
        return {"status": "ok", "source_revision": revision, "results": results}
    next_offset = offset + len(results)
    has_more = next_offset < len(identifiers)
    next_cursor = base64.urlsafe_b64encode(json.dumps({'version': 1, 'revision': revision,
        'fingerprint': fingerprint, 'offset': next_offset}, separators=(',', ':')).encode()).decode().rstrip('=') if has_more else None
    return {"status": "ok", "mode": "full", "source_revision": revision,
            "requested_ids": identifiers, "requested_count": len(identifiers),
            "returned_ids": page_ids, "returned_count": len(results), "offset": offset,
            "complete": not has_more, "has_more": has_more, "next_cursor": next_cursor,
            "results": results}
