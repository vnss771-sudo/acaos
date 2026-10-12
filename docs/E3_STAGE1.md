# E3 stage 1 — read-only website collection

No API route, scheduled discovery, consent integration, or outbound action is enabled by this patch. `collectWebsiteDocument` requires HTTPS on port 443, forbids URL credentials and query strings, validates all A/AAAA records, and pins its HTTPS socket to the inspected public IPv4 address. Each redirect is revalidated. The body is capped at 512 KiB, the per-request timeout is 8 seconds, and only text/html or text/plain is accepted.

## Unresolved before production integration
- Establish a dedicated egress firewall/proxy policy (application-only SSRF controls are not sufficient defense in depth).
- Add domain-level robots and crawl-permission policy; rate limiting, concurrency and global time budgets.
- Add domain allowlisting/approval, capture retention, data privacy policy and auditable provenance storage.
- Add careful HTML-to-text extraction and isolate page text as untrusted data; never treat page claims as validated consent.
- Extend IP-policy tests with vetted public/private IPv6 support and all non-global/reserved ranges; stage 1 deliberately denies IPv6 entirely.
- Set end-to-end collection budgets and stop redirects from yielding oversized bodies before consuming network resources; current transport caps body bytes but not header bytes at the TLS ingress level.
- Test with actual Node 26 dependencies/CI; stage 1 tests use mock transport, not live websites.
