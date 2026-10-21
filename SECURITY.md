# Security

Please report vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/shuaige121/mychrome-mcp/security/advisories/new). Do not include credentials, private browsing content or account data in a public issue.

Describe the affected release, the expected boundary, minimal reproduction steps with synthetic data, and the observed impact. Areas of particular interest include input ownership, cancellation, tab ownership, local IPC, source installation and unintended disclosure of page content.

Security fixes target the latest source release. Older releases may require an update; there is no guaranteed response time.

MyChrome operates your real Chrome and returns selected page content to your AI client. Client permissions and data handling still apply. Website routines and operation metadata remain local but can reveal usage context. Keep runtime data private, and authorize only the tasks you intend to perform.

MyChrome is not a sandbox for an untrusted AI client. See the [first-use guide](docs/getting-started.md#your-controls) for stopping and pausing actions.
