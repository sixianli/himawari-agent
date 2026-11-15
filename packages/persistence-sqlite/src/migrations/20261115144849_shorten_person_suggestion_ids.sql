UPDATE memory_person_suggestions
SET id = 'person-suggestion:' || lower(hex(randomblob(16)))
WHERE length(id) > 128;
