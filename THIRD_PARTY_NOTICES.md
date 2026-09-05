# Third-party notices

Operix includes third-party npm packages and the Noto Sans KR font. Their rights remain with their respective authors. The table below records declarations in the installed packages/lockfile; it does not grant a license for company-authored Operix code.

| Direct runtime dependency | Version | Declared license | Included license |
| --- | --- | --- | --- |
| @electric-sql/pglite | 0.5.8 | Apache-2.0 | [LICENSE](docs/third-party/licenses/electric-sql_pglite-LICENSE) |
| @fontsource/noto-sans-kr | 5.3.0 | OFL-1.1 | [LICENSE](docs/third-party/licenses/fontsource_noto-sans-kr-LICENSE) |
| exceljs | 4.4.0 | MIT | [LICENSE](docs/third-party/licenses/exceljs-LICENSE) |
| iron-session | 9.0.1 | MIT | [LICENSE.md](docs/third-party/licenses/iron-session-LICENSE.md) |
| lucide-react | 1.41.0 | ISC | [LICENSE](docs/third-party/licenses/lucide-react-LICENSE) |
| next | 16.3.4 | MIT | [license.md](docs/third-party/licenses/next-license.md) |
| pg | 8.23.0 | MIT | [LICENSE](docs/third-party/licenses/pg-LICENSE) |
| react | 19.2.8 | MIT | [LICENSE](docs/third-party/licenses/react-LICENSE) |
| react-dom | 19.2.8 | MIT | [LICENSE](docs/third-party/licenses/react-dom-LICENSE) |
| tsx | 4.23.13 | MIT | [LICENSE](docs/third-party/licenses/tsx-LICENSE) |
| zod | 4.5.4 | MIT | [LICENSE](docs/third-party/licenses/zod-LICENSE) |

A [production dependency inventory](docs/third-party/npm-production.json) also records transitive/optional package license declarations. Upstream license and notice files in each distributed package remain authoritative. Generated Docker images include additional operating-system components; review the exact image distribution before redistributing it.

ClamAV and PostgreSQL are separate, unmodified service images referenced by Compose. Their upstream distributions carry their own licenses and source information: [ClamAV source](https://github.com/Cisco-Talos/clamav), [PostgreSQL license](https://www.postgresql.org/about/licence/).

The company has not selected a redistribution/reuse license for its own Operix code. This file records third-party notices and does not select one on its behalf.
