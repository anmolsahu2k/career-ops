# ATS parity fixtures

Minimal HTML shells used to document and expand certified-board coverage.
They are not live ATS pages; they encode the control shapes the runner and
extension must recognize before a portal is treated as production-ready.

| Fixture | Board | Intent |
|---|---|---|
| `../greenhouse.html` | greenhouse | Classic fields + attach controls |
| `../workday-*.html` | workday | Date/moniker/questionnaire/upload shapes |
| `parity/lever-submit.html` | lever | Exact Submit label + required text |
| `parity/successfactors-login.html` | successfactors | Login wall must become WAITING_LOGIN |
| `parity/ashby-application-tab.html` | ashby | Application tab before fields |

LinkedIn and Handshake remain deferred: they require an explicit
`applications.main_profile.cdp_url` and never copy the live Chrome profile.
