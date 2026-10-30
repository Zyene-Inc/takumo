# Demo shop: Acme Precision

A small CNC + sheet-metal job shop used for local development, the database seed
(`pnpm db:seed`) and the engine tests (`pnpm test:engine`).

5 work centers · 3 customers · 6 parts with routings · 6 open orders · 8 past quotes ·
6 weeks of job history (`jobs.csv`: 24 closed orders, 52 finished operations with actual times).
In the history the P-2001 lathe setup really takes about 120 min (the routing says 90) and
the P-3001 brake run is about 12% slower than routed: what recalibration should find.
Times are in minutes; `hours_per_day` is available capacity per work center.
