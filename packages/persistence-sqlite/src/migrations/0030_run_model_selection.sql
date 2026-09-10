ALTER TABLE runs ADD COLUMN model_selection_json TEXT CHECK (model_selection_json IS NULL OR json_valid(model_selection_json));
