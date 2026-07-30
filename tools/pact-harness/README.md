# pact-harness — install-free CLI bundle

Vendored, platform-agnostic build of the pact-harness CLI (Decision D13). No
`npm install`, no repo checkout, no runtime network dependency. Drop this folder
into any repo/runner
and call it directly:

```bash
node pact-harness.mjs can-i-deploy --oas provider.json --pact consumer.pact.json
node contract-gate.mjs --oas provider.json --pact consumer.pact.json \
  --routes runtime-openapi.json --subset subset.json --policy policy.json \
  --exceptions exceptions.json --environment lower --complete-results
node pact-harness.mjs record-verification --ledger contracts --oas o.json --pact p.json \
  --consumer-version $SHA --provider-version $PV
node pact-harness.mjs can-i-deploy --ledger contracts --pacticipant svc --version $SHA --to production
node scripts/ledger-sync.mjs --dir contracts --message "record: ..."
```

Commands: `postman-to-pact · oas-to-pact · oas-audit · oas-diff ·
validate-exceptions · bdc-verify · provider-verify · record-verification ·
record-deployment · can-i-deploy`.

`vendor/yaml` is MIT-licensed. `vendor/postman-cs/compare-routes.mjs` is pulled
from the exact repository, commit, and digest recorded in its PROVENANCE file.
Rebuild from source with `node scripts/build-bundle.mjs` in the pact-harness repo.
