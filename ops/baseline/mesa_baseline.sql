-- =====================================================================
-- MESA / SALA — S0 FROZEN RECONCILIATION BASELINE
-- Regenerating query set for ops/baseline/mesa_baseline_2026-08-15.json
--
-- Specification : MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md  (§19, slice S0)
-- Target        : Supabase STAGING  tdikhfeinufaahagmpjz
-- Generated     : 2026-08-15T15:00:12Z
-- Re-frozen     : 2026-08-15T15:42:33Z — Section I corrected; see the SECTION I
--                 block below and root_cause_9746dfdd_section_I in the JSON
--                 artifact. Sections A-H/J/K are unchanged from the original
--                 capture and were re-verified byte-identical at re-freeze time.
--
-- READ-ONLY BY CONSTRUCTION.
--   * Every statement is a SELECT.
--   * No DDL, no DML, no RPC invocation, no function call with write effects.
--   * Safe to run at any time; running it changes nothing.
--
-- ASSUMPTIONS MADE EXPLICIT
--   1. "CURRENT balance logic" is reproduced verbatim from the live bodies of
--      mesa_close_session_v1 (L41-L51) and mesa_post_payment_v1 (L84-L94):
--          FROM table_order_lines l
--          JOIN ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
--         WHERE l.table_session_id = <session>
--           AND upper(COALESCE(o.estado,'')) NOT IN
--               ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')
--      followed by GREATEST(0, total - paid).
--      Both RPCs use an identical predicate; either may be cited.
--   2. "TARGET balance logic" is V2.1.1 §13: every table_order_lines row counts,
--      no join to ordenes, no clamping. table_ledger_adjustments does not exist
--      yet, so reductions(S) = 0 for every session at this baseline.
--   3. Money is compared in integer cents via round(numeric * 100).
--   4. Bucket 'order_deleted'  = no ordenes row with that display id at all.
--      Bucket 'order_delinked' = an ordenes row exists but its table_session_id
--                                differs from the line's.
--      Bucket 'cancelled_estado' / 'forced_close' = joined row present but its
--      estado is excluded by the current predicate. V2.1.1 §19 §F states a single
--      frozen expectation of 1 line / EUR 10.00 for the estado-excluded
--      population; §26 splits it into taxonomy buckets 3 and 4. Both labels are
--      emitted so the coarse and fine classifications stay reconcilable.
--   5. Section C uses service_session_audit ONLY. Schedule-derived inference
--      (resolveSchedule) is forbidden by V2.1.1 §20 and is not used anywhere here.
-- =====================================================================


-- ---------------------------------------------------------------------
-- SHARED CLASSIFIER — line visibility under the CURRENT predicate
-- ---------------------------------------------------------------------
-- Reused conceptually by sections A and F below. Repeated inline in each
-- section so every statement is independently runnable.


-- =====================================================================
-- SECTION A — current vs target balance, orphaned lines,
--             closed-with-outstanding sessions
-- =====================================================================
WITH lb AS (
  SELECT l.id AS line_id, l.table_session_id, l.order_id,
         round(l.net_amount * 100)::bigint AS cents,
         (oj.id IS NOT NULL
          AND upper(COALESCE(oj.estado,'')) NOT IN
              ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')) AS visible_now
    FROM public.table_order_lines l
    LEFT JOIN public.ordenes oj
           ON oj.id = l.order_id
          AND oj.table_session_id = l.table_session_id
),
per AS (
  SELECT ts.id AS table_session_id, ts.status, ts.settled_at,
         COALESCE(sum(lb.cents) FILTER (WHERE lb.visible_now), 0)::bigint     AS current_total_cents,
         COALESCE(sum(lb.cents), 0)::bigint                                   AS target_total_cents,
         COALESCE(count(*) FILTER (WHERE NOT lb.visible_now), 0)              AS invisible_lines,
         COALESCE(sum(lb.cents) FILTER (WHERE NOT lb.visible_now), 0)::bigint AS invisible_cents
    FROM public.table_sessions ts
    LEFT JOIN lb ON lb.table_session_id = ts.id
   GROUP BY ts.id, ts.status, ts.settled_at
),
paid AS (
  SELECT pt.table_session_id,
         COALESCE(sum((CASE pt.kind WHEN 'refund' THEN -1 ELSE 1 END)
                      * round(pa.amount * 100)), 0)::bigint AS settled_cents
    FROM public.payment_allocations pa
    JOIN public.payment_transactions pt ON pt.id = pa.payment_transaction_id
   GROUP BY pt.table_session_id
)
SELECT p.table_session_id, p.status, (p.settled_at IS NOT NULL) AS has_settled_at,
       p.current_total_cents, p.target_total_cents,
       COALESCE(pd.settled_cents, 0) AS settled_cents,
       GREATEST(0, p.current_total_cents - COALESCE(pd.settled_cents,0)) AS current_outstanding_cents,
       (p.target_total_cents - COALESCE(pd.settled_cents,0))             AS target_outstanding_cents,
       p.invisible_lines, p.invisible_cents
  FROM per p
  LEFT JOIN paid pd ON pd.table_session_id = p.table_session_id
 WHERE p.invisible_lines > 0
    OR (p.target_total_cents - COALESCE(pd.settled_cents,0)) <> 0
 ORDER BY p.invisible_cents DESC, p.table_session_id;


-- =====================================================================
-- SECTION B — order/line service attribution mismatch  (F-02)
-- =====================================================================
SELECT l.order_id, l.table_session_id,
       l.service_session_id AS line_service,
       o.service_session_id AS order_service,
       count(*)                        AS lines,
       sum(round(l.net_amount * 100))  AS cents
  FROM public.table_order_lines l
  JOIN public.ordenes o
    ON o.id = l.order_id
   AND o.table_session_id = l.table_session_id
 WHERE l.service_session_id IS DISTINCT FROM o.service_session_id
 GROUP BY 1,2,3,4
 ORDER BY cents DESC, l.order_id;


-- =====================================================================
-- SECTION C — historical receipt-service reconstruction
--             Evidence: service_session_audit ONLY. Never the schedule.
-- =====================================================================
WITH audit_min AS (
  SELECT service_session_id,
         min(created_at) FILTER (WHERE event_type = 'opened') AS opened_at,
         min(created_at) FILTER (WHERE event_type IN ('closed','rolled_over_economic')) AS terminal_at
    FROM public.service_session_audit
   GROUP BY 1
),
audit_floor AS (SELECT min(created_at) AS first_audit FROM public.service_session_audit),
recon AS (
  SELECT pt.id AS tx_id, pt.created_at, pt.amount, pt.by_actor, pt.table_session_id,
         pt.service_session_id AS stored_service,
         (SELECT array_agg(a.service_session_id) FROM audit_min a
           WHERE a.opened_at IS NOT NULL
             AND a.opened_at <= pt.created_at
             AND (a.terminal_at IS NULL OR a.terminal_at > pt.created_at)) AS candidates,
         (SELECT first_audit FROM audit_floor) AS first_audit
    FROM public.payment_transactions pt
)
SELECT tx_id, created_at, amount, by_actor, table_session_id, stored_service,
       CASE
         WHEN created_at < first_audit                              THEN 'unresolvable'
         WHEN candidates IS NULL OR cardinality(candidates) = 0     THEN 'off_service'
         WHEN cardinality(candidates) = 1                           THEN 'resolved'
         ELSE 'unresolvable'
       END AS classification,
       CASE WHEN candidates IS NOT NULL AND cardinality(candidates) = 1
            THEN candidates[1] END AS reconstructed_service,
       COALESCE(cardinality(candidates), 0) AS candidate_count
  FROM recon
 ORDER BY created_at;


-- =====================================================================
-- SECTION D — recycled display identity  (F-09)
-- =====================================================================
WITH creations AS (
  SELECT orden_id AS display_id, count(*) AS created_events,
         min(created_at) AS first_created, max(created_at) AS last_created
    FROM public.orden_estado_logs
   WHERE lower(COALESCE(event_type,'')) LIKE '%creat%'
   GROUP BY 1
),
line_sessions AS (
  SELECT order_id AS display_id,
         count(DISTINCT table_session_id)   AS line_table_sessions,
         count(DISTINCT service_session_id) AS line_services
    FROM public.table_order_lines GROUP BY 1
),
storico_rows AS (
  SELECT orden_id AS display_id, count(*) AS storico_rows,
         count(DISTINCT service_session_id) AS storico_services
    FROM public.storico GROUP BY 1
),
allk AS (
  SELECT display_id FROM creations
  UNION SELECT display_id FROM line_sessions
  UNION SELECT display_id FROM storico_rows
)
SELECT a.display_id,
       COALESCE(c.created_events, 0)       AS created_events,
       COALESCE(ls.line_table_sessions, 0) AS line_table_sessions,
       COALESCE(ls.line_services, 0)       AS line_services,
       COALESCE(s.storico_rows, 0)         AS storico_rows,
       COALESCE(s.storico_services, 0)     AS storico_services
  FROM allk a
  LEFT JOIN creations     c  ON c.display_id  = a.display_id
  LEFT JOIN line_sessions ls ON ls.display_id = a.display_id
  LEFT JOIN storico_rows  s  ON s.display_id  = a.display_id
 WHERE COALESCE(c.created_events, 0) > 1
    OR COALESCE(ls.line_table_sessions, 0) > 1
    OR COALESCE(s.storico_rows, 0) > 1
 ORDER BY 1;


-- =====================================================================
-- SECTION E — payment intent idempotency duplicates
--             Gate for S1's narrowed unique index.
-- =====================================================================
SELECT workspace_id, client_request_id,
       count(*)                     AS rows,
       count(DISTINCT request_hash) AS distinct_request_hashes,
       count(DISTINCT by_actor)     AS distinct_actors,
       count(DISTINCT by_sid_hash)  AS distinct_sids
  FROM public.payment_transactions
 GROUP BY 1,2
HAVING count(*) > 1
 ORDER BY 1,2;
-- Empty result set  => S1's UNIQUE (workspace_id, client_request_id) is safe.
-- Any row with distinct_request_hashes > 1 is STOP condition 2.


-- =====================================================================
-- SECTION F — cancelled / deleted / de-linked financial-line populations
-- =====================================================================
WITH lb AS (
  SELECT l.id AS line_id, l.table_session_id, l.order_id,
         round(l.net_amount * 100)::bigint AS cents,
         CASE
           WHEN oany.id IS NULL THEN 'order_deleted'
           WHEN oj.id   IS NULL THEN 'order_delinked'
           WHEN upper(COALESCE(oj.estado,'')) = 'CHIUSO_FORZATO' THEN 'forced_close'
           WHEN upper(COALESCE(oj.estado,'')) IN ('ANULADO','CANCELADO','CANCELLED')
                THEN 'cancelled_estado'
           ELSE 'visible'
         END AS bucket
    FROM public.table_order_lines l
    LEFT JOIN public.ordenes oj   ON oj.id = l.order_id
                                 AND oj.table_session_id = l.table_session_id
    LEFT JOIN public.ordenes oany ON oany.id = l.order_id
)
SELECT bucket,
       count(*)                                        AS lines,
       sum(cents)                                      AS cents,
       count(DISTINCT table_session_id)                AS table_sessions,
       array_agg(DISTINCT order_id ORDER BY order_id)  AS order_ids
  FROM lb GROUP BY bucket ORDER BY bucket;
-- Frozen expectation groups 'forced_close' + 'cancelled_estado' into the single
-- coarse label 'cancelled_estado' (1 line / 1000 cents). See assumption 4.


-- =====================================================================
-- SECTION G — storico completeness and NULL guards
--             Preconditions for S7's SET NOT NULL + unique index.
-- =====================================================================
SELECT 'G1_null_service_session' AS probe, count(*)::text AS v
  FROM public.storico WHERE service_session_id IS NULL
UNION ALL SELECT 'G2_null_orden_id', count(*)::text
  FROM public.storico WHERE orden_id IS NULL
UNION ALL SELECT 'G3_same_session_display_dupes', count(*)::text FROM (
  SELECT service_session_id, orden_id FROM public.storico
   GROUP BY 1,2 HAVING count(*) > 1) t
UNION ALL SELECT 'G4_storico_total_rows', count(*)::text FROM public.storico
UNION ALL SELECT 'G5_orders_with_lines_absent_from_storico', count(*)::text FROM (
  SELECT DISTINCT l.order_id, l.service_session_id
    FROM public.table_order_lines l
   WHERE NOT EXISTS (SELECT 1 FROM public.storico s
                      WHERE s.orden_id = l.order_id
                        AND s.service_session_id = l.service_session_id)) t
UNION ALL SELECT 'G6_369_storico_rows', count(*)::text
  FROM public.storico WHERE orden_id = '#369'
UNION ALL SELECT 'G7_369_distinct_services', count(DISTINCT service_session_id)::text
  FROM public.storico WHERE orden_id = '#369'
UNION ALL SELECT 'G8_live_orders_bad_service_ref', count(*)::text
  FROM public.ordenes o
 WHERE o.service_session_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.service_sessions ss WHERE ss.id = o.service_session_id);


-- =====================================================================
-- SECTION H — service_closeouts + the unallocated-payment invariant (§12)
-- =====================================================================
SELECT sc.service_session_id, ss.status AS session_status, ss.business_date, sc.created_at
  FROM public.service_closeouts sc
  LEFT JOIN public.service_sessions ss ON ss.id = sc.service_session_id
 ORDER BY sc.created_at;

SELECT pt.id AS payment_transaction_id, pt.amount,
       COALESCE(sum(pa.amount), 0)                                     AS allocated,
       round(pt.amount*100) - round(COALESCE(sum(pa.amount),0)*100)     AS delta_cents
  FROM public.payment_transactions pt
  LEFT JOIN public.payment_allocations pa ON pa.payment_transaction_id = pt.id
 GROUP BY pt.id, pt.amount
 ORDER BY abs(round(pt.amount*100) - round(COALESCE(sum(pa.amount),0)*100)) DESC, pt.id;
-- Every delta_cents must be 0. Any non-zero row is STOP condition 3.


-- =====================================================================
-- SECTION I — residue and incident backing per service session
-- CORRECTED in the V2.1.2 re-freeze: the V2.1.1 frozen expectation
-- ("9746dfdd: 5 open orders, 0 incidents") took service_closeouts.incident_count
-- at face value. That stored value is PROVEN WRONG AT WRITE TIME — see
-- MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md §0.1 and §19 slice S18.
-- This section now captures BOTH the (known-incorrect) historical stored
-- counter AND the true, independently-derived point-in-time population.
-- =====================================================================
WITH nonterm AS (
  SELECT o.service_session_id, count(*) AS non_terminal_orders
    FROM public.ordenes o
   WHERE o.service_session_id IS NOT NULL
     AND (o.estado IS NULL OR upper(o.estado) NOT IN
          ('ENTREGADO','RETIRADO','CANCELADO','ANULADO','CANCELLED','CHIUSO_FORZATO','ARCHIVADO'))
   GROUP BY 1
),
inc AS (SELECT service_session_id, count(*) AS incidents FROM public.service_incidents GROUP BY 1)
SELECT ss.id AS service_session_id, ss.status, ss.business_date,
       COALESCE(n.non_terminal_orders, 0) AS non_terminal_orders,
       COALESCE(i.incidents, 0)           AS session_incidents
  FROM public.service_sessions ss
  LEFT JOIN nonterm n ON n.service_session_id = ss.id
  LEFT JOIN inc     i ON i.service_session_id = ss.id
 WHERE ss.status <> 'open' OR COALESCE(n.non_terminal_orders, 0) > 0
 ORDER BY ss.business_date, ss.id;

-- Per-residue-order incident backing (the measure that decides "incident-backed")
WITH residue AS (
  SELECT o.service_session_id, o.id AS order_id, o.estado
    FROM public.ordenes o
   WHERE o.service_session_id IN ('9746dfdd-4d30-4b4d-a7c6-8d285b4fca98',
                                  'c9d5aaa7-d0d5-4740-a6ee-83a8ee57adda')
     AND (o.estado IS NULL OR upper(o.estado) NOT IN
          ('ENTREGADO','RETIRADO','CANCELADO','ANULADO','CANCELLED','CHIUSO_FORZATO','ARCHIVADO'))
)
SELECT r.service_session_id, r.order_id, r.estado,
       (SELECT count(*) FROM public.service_incidents si
         WHERE si.service_session_id = r.service_session_id
           AND (si.order_id = r.order_id
                OR (si.entity_type = 'order' AND si.entity_id = r.order_id))
       ) AS incidents_for_this_order
  FROM residue r
 ORDER BY r.service_session_id, r.order_id;

-- I.1 — the (known-incorrect) historical stored closeout counter for 9746dfdd,
-- and the canonical S18 counter-authority query re-derived against the SAME
-- closeout_correlation_id, evaluated as of the SAME point in time (the
-- closeout's own closed_at). This is the query S18 mandates every
-- create_service_closeout call derive server-side, applied here retroactively
-- as a read-only proof, never as a write.
SELECT sc.id AS closeout_id, sc.closeout_correlation_id, sc.closed_at,
       sc.close_source, sc.incident_count AS stored_incident_count,
       sc.kitchen_pending_count AS stored_kitchen_pending_count,
       sc.listo_count AS stored_listo_count,
       (SELECT count(*) FROM public.service_incidents si
         WHERE si.closeout_correlation_id = sc.closeout_correlation_id
           AND si.created_at <= sc.closed_at) AS true_incident_count_at_insert,
       (SELECT count(*) FROM public.service_incidents si
         WHERE si.closeout_correlation_id = sc.closeout_correlation_id
           AND si.incident_type = 'KITCHEN_WORK_PENDING_AT_CLOSE'
           AND si.created_at <= sc.closed_at) AS true_kitchen_pending_at_insert,
       (SELECT count(*) FROM public.service_incidents si
         WHERE si.closeout_correlation_id = sc.closeout_correlation_id
           AND si.incident_type = 'ORDER_READY_NOT_FINALIZED_AT_CLOSE'
           AND si.created_at <= sc.closed_at) AS true_listo_at_insert,
       (SELECT count(*) FROM public.service_incidents si
         WHERE si.closeout_correlation_id = sc.closeout_correlation_id
           AND si.created_at > sc.closed_at) AS incidents_created_after_closeout
  FROM public.service_closeouts sc
 WHERE sc.service_session_id = '9746dfdd-4d30-4b4d-a7c6-8d285b4fca98';
-- Expected: stored_incident_count=0 (known incorrect); true_incident_count_at_insert=6;
-- true_kitchen_pending_at_insert=4; true_listo_at_insert=1;
-- incidents_created_after_closeout=5. stored != true proves the write-order defect;
-- true + after = 11 = the current total, proving nothing was lost, only mis-timed.


-- =====================================================================
-- SECTION J — TWO SEPARATE INVENTORIES (V2.1.1 §17.1)
--   J.1 append-only / immutability trigger inventory
--   J.2 the S8 bypass set — payment_transactions MUST NOT appear
-- =====================================================================
SELECT c.relname AS tbl, t.tgname, t.tgenabled,
       pg_get_userbyid(c.relowner) AS owner,
       CASE WHEN t.tgtype & 2  > 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
       CASE WHEN t.tgtype & 8  > 0 THEN 'DELETE ' ELSE '' END ||
       CASE WHEN t.tgtype & 16 > 0 THEN 'UPDATE ' ELSE '' END ||
       CASE WHEN t.tgtype & 4  > 0 THEN 'INSERT'  ELSE '' END AS events
  FROM pg_trigger t
  JOIN pg_class c     ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal AND n.nspname = 'public'
   AND c.relname IN ('table_order_lines','payment_allocations','payment_transactions',
                     'order_financial_events','service_incidents')
 ORDER BY c.relname, t.tgname;
-- tgenabled must be 'O' (enabled) for every row. Anything else is STOP condition 8.

-- J.3 order_financial_events partial unique-index definitions + NULL census
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'order_financial_events'
 ORDER BY indexname;

SELECT count(*) AS ofe_rows_with_null_service_session
  FROM public.order_financial_events WHERE service_session_id IS NULL;

-- J.2 exact row counts for the four bypass tables
SELECT 'table_order_lines' AS tbl, count(*) FROM public.table_order_lines
UNION ALL SELECT 'payment_allocations',    count(*) FROM public.payment_allocations
UNION ALL SELECT 'order_financial_events', count(*) FROM public.order_financial_events
UNION ALL SELECT 'service_incidents_entity_order', count(*)
  FROM public.service_incidents WHERE entity_type = 'order'
 ORDER BY 1;

-- J.4 service_incidents_immutable_facts mutable-key list, verbatim
SELECT pg_get_functiondef(p.oid) AS service_incidents_immutable_facts_body
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'service_incidents_immutable_facts';


-- =====================================================================
-- SECTION K — migration-ledger bootstrap input
-- =====================================================================
SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'supabase_migrations' AND c.relname = 'schema_migrations')
         AS supabase_ledger_exists,
       (SELECT count(*) FROM supabase_migrations.schema_migrations)
         AS supabase_ledger_rows,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'ladieci_schema_migrations')
         AS ladieci_ledger_exists;
-- ladieci_ledger_exists MUST be 0 at S0. S4 creates it; S0 never does.

SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;
-- Joined against migrations/MIGRATION_MANIFEST.md (70 rows) outside SQL:
-- a manifest row whose filename slug appears here is classified 'verified';
-- otherwise 'bootstrapped_unverified'. See the JSON artifact, section K.


-- =====================================================================
-- PRE-S0 DRIFT PROBES — none of these objects may exist before S1..S19
-- =====================================================================
SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('order_entities','table_ledger_adjustments',
                             'ledger_adjustment_operations','ladieci_schema_migrations',
                             'schema_migrations')) AS new_tables_present,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('mesa_cancel_order_v1','mesa_write_off_v1',
                             'mesa_table_session_balance_v1','order_entity_anchor_v1',
                             'mesa_singleton_workspace_v1','table_ledger_adjustment_derive_v1'))
         AS new_functions_present,
       (SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE ic.relname = 'payment_transactions_idempotency_uq') AS payment_idempotency_index,
       (SELECT is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='payment_transactions'
           AND column_name='service_session_id') AS pt_service_session_nullable;
-- Expected at S0: 0, 0, the 4-column index, 'NO'.
