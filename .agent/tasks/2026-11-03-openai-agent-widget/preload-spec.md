# Preload complete results for the site widget

AC1. Agent completes catalog pagination before answering, classifies all returned records and preserves the catalog snapshot, unique identity, total and selected/rejected/uncertain decisions. If pages are incomplete or inconsistent, fail closed rather than pretend the list is complete.
AC2. On first response transmit and persist the complete selected list; buyer sees 10 initially. Each click reveals exactly 10 more locally, without network calls or additional model tokens. No duplicate items and final partial page is correct.
AC3. Product data and links come from the matching catalog records, and rejected or uncertain products never appear in suitable cards. Text must not list all hidden products.
AC4. Do not silently truncate results at 50 in the live response or history; bound actual payloads explicitly and fail if the full list cannot fit.
AC5. Tests cover multi-page gathering, missing pages and duplicates, explicit classifications, restored history, local increments, and more than 50 records. After GitHub deployment, verify actual widget on bakautprof.ru through all pages plus an excluded product.
