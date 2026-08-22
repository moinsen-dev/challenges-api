-- Hamburg first: only what is unlocked exists as a title level.

INSERT INTO seasons (id, name, starts_at, ends_at, status) VALUES
  ('s1', 'Season 1', '2026-08-01T00:00:00Z', '2026-11-30T23:59:59Z', 'open');

INSERT INTO regions (id, parent_id, level, name) VALUES
  ('world',   NULL,      6, 'Welt'),
  ('eu',      'world',   5, 'Europa'),
  ('de',      'eu',      4, 'Deutschland'),
  ('hh',      'de',      3, 'Hamburg'),
  ('hh-city', 'hh',      2, 'Hamburg'),
  ('hh-eimsbuettel', 'hh-city', 1, 'Eimsbuettel'),
  ('hh-altona',      'hh-city', 1, 'Altona'),
  ('hh-nord',        'hh-city', 1, 'Hamburg-Nord'),
  ('hh-mitte',       'hh-city', 1, 'Hamburg-Mitte'),
  ('hh-wandsbek',    'hh-city', 1, 'Wandsbek'),
  ('hh-bergedorf',   'hh-city', 1, 'Bergedorf'),
  ('hh-harburg',     'hh-city', 1, 'Harburg');

-- Platform-wide badges: the reason to start a second app on the platform.
INSERT INTO badges (id, app_id, name, description, rule, created_at) VALUES
  ('journeyman', NULL, 'Wandergeselle', 'In drei Apps der Plattform qualifiziert.',
     '{"type":"qualified_in_n_apps","n":3}', '2026-08-22T00:00:00Z'),
  ('double-master', NULL, 'Doppelmeister', 'Eine Pruefung mit dem Doppelten der Schwelle bestanden.',
     '{"type":"discipline_mastery","factor":2}', '2026-08-22T00:00:00Z'),
  ('two-districts', NULL, 'Zweibezirker', 'Titel in zwei verschiedenen Bezirken.',
     '{"type":"titles_in_n_regions","n":2}', '2026-08-22T00:00:00Z'),
  ('steadfast', NULL, 'Standhaft', 'Eine Serie von sieben Tagen in irgendeiner Disziplin.',
     '{"type":"streak_days","days":7}', '2026-08-22T00:00:00Z'),
  ('devoted', NULL, 'Ausdauernd', 'An dreissig verschiedenen Tagen etwas eingetragen.',
     '{"type":"active_on_n_days","n":30}', '2026-08-22T00:00:00Z');
