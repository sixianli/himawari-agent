CREATE TABLE perception_search_terms (
  record_id TEXT NOT NULL REFERENCES perception_records(id) ON DELETE CASCADE,
  term TEXT NOT NULL CHECK (length(term) BETWEEN 16 AND 128),
  PRIMARY KEY (record_id, term)
) STRICT;

CREATE INDEX perception_search_terms_term_index
  ON perception_search_terms(term, record_id);
