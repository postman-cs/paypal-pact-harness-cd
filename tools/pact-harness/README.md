# pact-harness — install-free CLI bundle

Vendored, platform-agnostic build of the pact-harness CLI (Decision D13). No
`npm install`, no repo checkout, no network. Drop this folder into any repo/runner
and call it directly:

```bash
node pact-harness.mjs can-i-deploy --oas provider.json --pact consumer.pact.json
node pact-harness.mjs record-verification --ledger contracts --oas o.json --pact p.json \
  --consumer-version $SHA --provider-version $PV
node pact-harness.mjs can-i-deploy --ledger contracts --pacticipant svc --version $SHA --to production
node scripts/ledger-sync.mjs --dir contracts --message "record: ..."
```

Commands: `postman-to-pact · oas-to-pact · bdc-verify · provider-verify ·
record-verification · record-deployment · can-i-deploy`.

Only third-party code is `vendor/yaml` (MIT) — its licence travels in that folder.
Rebuild from source with `node scripts/build-bundle.mjs` in the pact-harness repo.
