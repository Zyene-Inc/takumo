# Takumo: market, positioning and pricing

Why Takumo exists, who it is for, who else is in the market, and how it is priced. What we are building and when is in [PRODUCT-PLAN.md](PRODUCT-PLAN.md); where it stands is in [STATUS.md](STATUS.md).

## The problem

Small and mid-sized manufacturers (20–300 people, $5M–$100M revenue) run on:
- **Tribal knowledge:** real setup times, which machine runs which job best, and why a part fails all live in 2–3 veterans' heads. When they retire or leave, the knowledge is gone.
- **Spreadsheets and old ERPs** (JobBOSS, E2, ProShop, QuickBooks). The data is there, but nobody can ask it questions.
- **Slow, risky quoting:** an estimator takes 1–3 days per RFQ, guesses the lead time, and doesn't know whether the shop has capacity. That leads to lost jobs, missed dates and thin margins.
- **Planning by gut feel:** "Can we squeeze this 4,000-unit order in by the 30th?" is answered by walking the floor and asking around.

**The result:** lost RFQs, late deliveries, margin leaking from setup time and overtime, and a business that depends on a few people.

## Who it's for

| | |
|---|---|
| Primary | Job shops and contract manufacturers (CNC machining, sheet metal, fabrication, injection molding) in the US, with 20–300 employees |
| Buyer | Owner, GM or VP of Operations |
| Daily users | Estimator, production planner or scheduler, shop floor lead |
| Not now | Defense primes needing ITAR, process plants, companies with 1,000+ employees (Cognite and the big ERP vendors serve these) |

## Competitors and positioning

Competitors as of November 2026. Funding and results are the companies' own claims.

| Group | Who | What they do | Funding / status |
|---|---|---|---|
| AI quoting | **Forgepoint** ("Frank") | AI sales rep that reads RFQ emails and drafts quotes with the shop's own pricing rules | $9.8M seed (Primary, a16z speedrun), Oct 2026; says seven-figure revenue in 6 months |
| | **Paperless Parts** | Quoting from the CAD file, AI requirements review ("Wingman AI"), ERP integrations | The established leader |
| | **CloudNC Quote Agent** | Manufacturability check plus quote from CAD in minutes | $20M, Sept 2026; launching late 2026, free tier |
| | **QuotedPart** | STEP + drawing reading, suggested routing, prices with shop rates | $199/mo |
| | Dashnode, Toolpath, Machine Research, Mavlon | Smaller AI quoting tools for machine shops | Early stage |
| Job-shop ERP + AI | **Fulcrum Pro** ("Archie") | Cloud ERP with quoting, heuristic auto-scheduling and an AI assistant | AI launched July 2026 |
| | JobBOSS² (ECI) | Older ERP, static scheduling, AI Assistant announced | April 2026 |
| | ProShop, E2, Epicor, Global Shop | Established ERPs, little or no AI | Inside many target shops |
| Shop knowledge | **Corello** (corello.ai) | AI brain over the shop's documents and data; no quotes or scheduling | Early stage |
| | CADDi Drawer | Drawing and past-quote search, similar-shape search | US customers (e.g. Mitsubishi Materials USA) |

| | Corello / CADDi | Forgepoint / Paperless Parts / CloudNC | Fulcrum | **Takumo** |
|---|---|---|---|---|
| Knowledge brain (docs + tribal) | ✅ | ❌ | ❌ | ✅ **facts that keep their history** |
| Real calculation (scheduling, capacity) | ❌ | ❌ | ✅ heuristic | ✅ optimizer (CP-SAT) |
| Quote with **capacity-aware lead time + margin** | ❌ (no price) | Partial (price, no capacity check) | Partial (separate quote and schedule) | ✅ **core feature** |
| Model recalibrates from actual job data | ❌ | ❌ | ❌ | ✅ |
| Self-serve, value in under a day, priced for small shops | ✅ | ✅ | ✅ | ✅ |

**How to position:** quoting alone is now a crowded, funded race. Don't sell "AI quoting"; sell **"quotes you can actually deliver"**: price plus a lead time checked against real capacity. Watch Forgepoint (quoting) and Fulcrum (scheduling + AI) most closely.

**The rule that makes it trustworthy:** *The AI never produces numbers.* Claude turns the question into model operations, the **engines** (scheduler, simulation, SQL) compute the answer, and Claude explains it **with sources**. Every value is tagged `data`, `stated` or `assumed`.

## Pricing
| Plan | Price | For |
|---|---|---|
| Shop | **$499/mo** | 1 site, 5 users, ask + capacity + schedule |
| Pro | **$1,499/mo** | + Quote Copilot, connectors, unlimited users |
| Plant | Custom | Multi-site, SSO, onboarding service |

## Risks
| Risk | Mitigation |
|---|---|
| Messy data | A column-mapping wizard plus "assumed" tags; useful with partial data |
| Trust in AI numbers | Engines compute, Claude explains, every number cited |
| Long sales cycles | Self-serve trial with a demo shop; sell through associations |
| Competitors (Forgepoint, Paperless Parts, CloudNC, Fulcrum) | Our edge is capacity-aware quoting plus knowledge that keeps its history, not quoting alone |

## Funding path
- **Now:** NSF SBIR Project Pitch (Phase I up to ~$305K, no equity) · angels (shop owners, former Paperless Parts/Xometry people)
- **After design partners:** YC / a16z speedrun · pre-seed $250K–$750K
- **After paying shops:** seed $2–5M (Eclipse, Primary, Ironspring)
