# Remaining product-selection problems

1. A buyer still waits 51.868 seconds for this general recommendation. The selector uses embeddings but still sends every card in the category through a first model pass; whole-card ranking alone cannot safely reduce the universe without losing directly relevant cards.
2. The widget has 144 confirmed and 132 uncertain plates in one 276-card result. The uncertain group is separately labelled, but the total count can look like 276 confirmed matches.
3. Some confirmed plates require an optional protective mat for the stated use; the short answer does not name that condition. The first ten were source-audited, but all 144 confirmed cards were not independently validated.
4. 26 products formerly classified as confirmed moved to uncertain in the new live run. Eleven of those cards have a phrase matching tile/paver work, but the old labels are not a trusted gold standard. A product-use evidence index and a small manually checked reference set are needed before claiming no misses.

Do not add a hard top-K or similarity cutoff. It would hide relevant goods: the production ranking audit showed that a score cutoff of 0.50 would miss 97 of 170 plates whose cards explicitly mention tiles or paving blocks.
