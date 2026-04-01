@echo off
REM Manual trust graph scenarios based on test/fixtures/trust-graph.json
REM
REM All commands assume you run them from the repo root:
REM   C:\path\to\trust> manual-trust-graph-scenarios.bat
REM and that:
REM   - You have built the project (npm run build)
REM   - You have initialized an identity once with: npx . init --skip-profile
REM
REM The CLI entrypoint is always invoked as:
REM   npx . <command> [args...]
REM
REM Notes:
REM - The "issuer" in trust-graph.json is always "key 0" (the primary key).
REM   Here, that corresponds to your local identity created by `npx . init`.
REM - Subjects below are sample npub public keys; they act as stable
REM   identifiers for manual testing and roughly mirror the scenarios in
REM   test/fixtures/trust-graph.json (contexts: dev, commerce, test, etc.).
REM - All issue commands use --no-server to bypass the HTTP server and publish
REM   directly to relays, even if a Trust server is running.

echo.
echo === Scenario 1: direct trust in dev (issuer 0 -> subject 1, context=dev) ===
REM Expectation (from trust-graph.json):
REM   degree 1, trust 1, neutral 0, distrust 0
REM Subject S1 ~ "subject 1" (sample npub)
set S1=npub1c3lf9hdmghe4l7xcy8phlhepr66hz7wp5dnkpwxjvw8x7hzh0pesc9mpv4

REM Issue trust event (value=1, context=dev) from your local identity to S1
npx . issue %S1% -v 1 -c dev --no-server
REM npx . issue npub1c3lf9hdmghe4l7xcy8phlhepr66hz7wp5dnkpwxjvw8x7hzh0pesc9mpv4 -v 1 -c dev --no-server

REM Resolve trust from your local identity to S1 in dev context
REM (should show degree 1, trust 1)
npx . resolve %S1% -c dev --json

echo.
echo === Scenario 2: two-hop trust path in dev (0 -> 1 -> 2) ===
REM This approximates:
REM   connections: 0->1 (dev,1), 1->2 (dev,1)
REM   expectation: issuer 0 -> subject 2, context dev, degree 2, trust 1
REM Subject S2 ~ "subject 2" (sample npub)
set S2=npub1xtscya34g58tk0z605fvr788k263gsu6cy9x0mhnm87echrgufzsevkk5s

REM First edge: you trust S1 in dev (already done in Scenario 1, but safe to repeat)
npx . issue %S1% -v 1 -c dev --no-server

REM Second edge: you also trust S2 in dev; to approximate a 0->1->2 graph with a
REM single issuing identity, we just issue both edges from your key.
npx . issue %S2% -v 1 -c dev --no-server

REM Resolve from your local identity to S2 in dev
npx . resolve %S2% -c dev --json

echo.
echo === Scenario 3: neutral edge in dev (issuer 0 -> neutral_target) ===
REM Mirrors:
REM   0 -> 7 (value 0, context dev), expected neutral=1
REM Subject S_NEUTRAL ~ "neutral_target" (sample npub)
set S_NEUTRAL=npub1lhjkpn4kqkjn585dx7gwcefnktnw66sjskzny36xklmtaj09275sr85uw0

REM Issue neutral trust (value=0) in dev
npx . issue %S_NEUTRAL% -v 0 -c dev --no-server

REM Resolve; expect neutral count to be 1
npx . resolve %S_NEUTRAL% -c dev --json

echo.
echo === Scenario 4: direct distrust in dev (issuer 0 -> distrust_target) ===
REM Mirrors:
REM   0 -> 8 (value -1, context dev), expected distrust=1
REM Subject S_DIST ~ "distrust_target" (sample npub)
set S_DIST=npub1hejdgmrc5gfvns6qnzr0tlwuwemdax043ppqnjpavgzzcnhwdpdsxfrkv8

REM Issue distrust (value=-1) in dev
npx . issue %S_DIST% -v -1 -c dev --no-server

REM Resolve; expect distrust count to be 1
npx . resolve %S_DIST% -c dev --json

echo.
echo === Scenario 5: different context (commerce) ===
REM Mirrors:
REM   0 -> 2 (value 1, context commerce), expected degree 1 in commerce
REM Subject S_COMMERCE ~ "subject 2 in commerce" (re-use S2 here if desired)
set S_COMMERCE=%S2%

REM Issue trust in commerce context
npx . issue %S_COMMERCE% -v 1 -c commerce --no-server

REM Resolve in commerce context (should connect)
npx . resolve %S_COMMERCE% -c commerce --json

REM Resolve in dev context (should not show this commerce edge)
npx . resolve %S_COMMERCE% -c dev --json

echo.
echo Done. Review the JSON outputs above to compare with the expectations
echo from test/fixtures/trust-graph.json.
echo You can re-run individual npx commands or tweak subjects/contexts as needed.

