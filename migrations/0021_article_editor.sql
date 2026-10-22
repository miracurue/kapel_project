-- The public pointer and tags stay fixed until the author explicitly publishes.
ALTER TABLE library_items ADD COLUMN draft_tags_json TEXT;
UPDATE library_items SET draft_tags_json=tags_json;
ALTER TABLE library_chat ADD COLUMN status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('pending','done','error'));
ALTER TABLE library_items ADD COLUMN draft_version INTEGER;
UPDATE library_items SET draft_version=(SELECT max(version) FROM library_versions WHERE item_id=library_items.id);
