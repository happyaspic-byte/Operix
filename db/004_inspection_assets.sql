CREATE TABLE inspection_assets (
  inspection_id text NOT NULL REFERENCES inspections(id),
  asset_id text NOT NULL REFERENCES assets(id),
  PRIMARY KEY (inspection_id, asset_id)
);
CREATE INDEX inspection_assets_asset_idx ON inspection_assets(asset_id);

-- Keep the original target and every historical inspection/report unchanged.
INSERT INTO inspection_assets(inspection_id, asset_id)
SELECT id, asset_id FROM inspections;
