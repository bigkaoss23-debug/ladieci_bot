-- ===============================================================
-- 2026-05-14 — geo_cache confidence counters
-- ===============================================================
-- Aggiunge 2 contatori a geo_cache per costruire confidence "cache vs Google":
--
--   n_ordini_creati       → incrementato a creaOrdine (signal "operatore ha creduto")
--   n_ordini_consegnati   → incrementato a chiudiServizio per ogni ordine archiviato
--                           (NON dipende dal bottone driver RETIRADO — usa l'archiviazione
--                            automatica notturna come fonte di verità)
--
-- Regola di lettura (geoResolver.loadFromCache):
--   se n_ordini_consegnati >= 1 → cache "blindata" = autorità sopra Google,
--   non si rinfresca neanche in shadow mode.
-- ===============================================================

ALTER TABLE geo_cache ADD COLUMN IF NOT EXISTS n_ordini_creati INT DEFAULT 0;
ALTER TABLE geo_cache ADD COLUMN IF NOT EXISTS n_ordini_consegnati INT DEFAULT 0;
