# private-git-proxy

Fetch a file from a private GitHub repository on every `GET /` and return its
original bytes. No Gist, encryption workflow, decryption key, application cache,
or saved file is required. Node.js 24 LTS; no third-party runtime dependencies.

## Docker Compose

```sh
git clone https://github.com/rsivanov-git/private-git-proxy.git
cd private-git-proxy
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```dotenv
GIT_URL=https://raw.githubusercontent.com/OWNER/REPO/main/path/file.txt
GIT_TOKEN=YOUR_FINE_GRAINED_PERSONAL_ACCESS_TOKEN
```

These are the only application configuration parameters. They can also be set
directly under `environment` in `docker-compose.yml`. Keep real tokens out of
Git; `.env` is ignored and excluded from the Docker build context. Container
administrators can inspect environment variables, so protect access to Docker.

Create a **fine-grained personal access token** restricted to the source
repository, with **Contents: Read-only**. No write permissions are needed. Account
or organization approval may be required. Rotate the token before its expiry.
The service token is configured on the deployment host, not in this public
repository's CI. CI uses its own `GITHUB_TOKEN` only to publish images.

```sh
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:8080/
```

The image is `ghcr.io/rsivanov-git/private-git-proxy:latest`. Pin `1.0.0` or an
image digest for controlled upgrades. The provided Compose publishes port 8080
only on host `127.0.0.1`. The process runs as a non-root user with a read-only
filesystem, all Linux capabilities dropped, and no-new-privileges enabled.

## Tailscale

For the existing Tailscale Service `proxy-list`, on its configured service host:

```sh
sudo tailscale serve --bg --service=svc:proxy-list --https=443 http://127.0.0.1:8080
```

Open the service's HTTPS root URL to retrieve the file. No filename suffix is
needed. Service creation, host approval and access rules must already be in place.
For a new host without a named Service, standard Tailscale Serve can expose it:

```sh
tailscale serve --bg http://127.0.0.1:8080
```

Tailnet policy controls access to the service, including its optional fallback token.
Keep it private with Serve and tailnet policy; do not expose it with Funnel.
If replacing gist-decrypt, stop the old container before starting this one because
both examples use host port 8080. No Tailscale identity or SSH changes are needed.

## How authentication works

The configured raw URL is parsed and converted to the GitHub Contents API:

```text
GET https://api.github.com/repos/OWNER/REPO/contents/path/file.txt?ref=main
Authorization: Bearer <GIT_TOKEN>
Accept: application/vnd.github.raw+json
```

**The upstream URL never contains the token.** HTTPS certificate verification stays
enabled. Requests are sent only to the fixed `api.github.com` origin; redirects
are rejected. The service does not use GitHub's temporary `download_url` links.
For Surge, set the policy group option to
`policy-path=https://PART1:PART2@proxy-list.siberian-adder.ts.net/`.
Split one GitHub token into two nonempty parts. The server decodes HTTP Basic
credentials and concatenates the parts without a separator for this request.
The profile contains the full secret in recoverable form. Use HTTPS.

With no Authorization header, the server uses the optional GIT_TOKEN from the
environment. With neither, it returns 401 and a Basic challenge. Malformed or
unsupported credentials also return 401. A GitHub rejection retains the usual
502 response and never triggers a retry with the environment token.
Upstream headers, URLs, error details and tokens are not returned or logged.

Accepted URLs: `https://raw.githubusercontent.com/OWNER/REPO/REF/FILE` and
`.../OWNER/REPO/refs/heads/REF/FILE` (also `refs/tags`). Nested file paths and
percent-encoded names are supported. For refs containing slashes, encode the
entire ref as one segment, e.g. `feature%2Ftest`; unencoded slashes cannot be
unambiguously distinguished from file paths. No query, fragment, userinfo,
nonstandard port or alternative hostname is accepted. GitHub Enterprise and
other Git providers are not supported by this version. Source must be a file;
GitHub LFS pointers are returned as repository content, not resolved LFS objects.

References: [GitHub Contents API](https://docs.github.com/en/rest/repos/contents#get-repository-content),
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

## HTTP behavior

| Endpoint | Result |
| --- | --- |
| `GET /` | Fetch source and return original bytes as `text/plain; charset=utf-8`, without a fixed filename |
| `GET /healthz` | Process liveness, `200 ok`; does not contact GitHub |
| Other paths (including filename paths) | `404` |
| Other methods | `405` |
| GitHub failure, redirect, timeout, oversized response | `502` with a generic message |

Every root request makes a separate upstream request. There is no application
cache, request coalescing, conditional 304 response, or stale-data fallback.
Responses use `Cache-Control: no-store`; upstream requests also request no-cache.
GitHub's own caching and API rate limits remain outside the service's control.
A commit-pinned URL naturally continues to return that commit's file.

Upstream timeout: 15 seconds. Maximum response: 1 MiB. The response is buffered
within each request before sending it, so failed downloads do not return partial
files as successful responses. The buffer is not retained between requests.
Client disconnects abort the upstream request. File bytes are never written to disk.

## Development and release

```sh
npm test
node --env-file=.env src/server.mjs
docker build -t private-git-proxy:local .
docker run --rm --env-file .env -p 127.0.0.1:8080:8080 private-git-proxy:local
```

Tests use synthetic tokens and mocked GitHub responses. They cover URL validation,
header-only authentication, fresh requests, byte preservation, empty files,
upstream failures, redirects, limits, timeouts and routing. Live private repository
access requires your own deployment token; synthetic tests do not validate it.

CI on `main` and pull requests runs tests, validates Compose and builds Docker.
Publish a GitHub Release using a semantic version tag such as `v1.2.3` to trigger
the release workflow. It tests the release revision, then publishes a multi-platform
GHCR image for `linux/amd64` and `linux/arm64`. Stable version tags are `v1.2.3`,
`1.2.3`, `1.2`, `1` and `latest`; prereleases do not update `latest`.

Publishing uses the repository's `GITHUB_TOKEN` with `packages: write`. After the
first release, ensure the GHCR package visibility is public for anonymous pulls.
The release pipeline follows the same scheme as `gist-decrypt` and
`lampa-imdb-ratings`.
