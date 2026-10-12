# Security policy

Do not open a public issue for a vulnerability, an exposed credential, or a report that contains export content.

Email `security@calven.ai` with the affected file, the observed and expected behavior, reproduction steps with secrets removed, and the practical impact.

## How the tool handles access

- It signs in through Klue's own OAuth server with PKCE, on a redirect to `127.0.0.1`.
- Tokens and the registered client secret stay in memory and are never written to disk.
- After an OAuth export the tool revokes its tokens, and says so if the server does not allow it. A personal access token you pass is left alone.
- Each sign-in registers a new OAuth client with Klue, named `calven-migrate-from-klue`. Once its tokens are revoked it holds no access.
- The local sign-in page only acts on a request carrying the state this run created; any other request gets an error reply and changes nothing.
- Every OAuth endpoint the server names must use https.
- It talks only to the Klue server and writes only to the output folder. It sends nothing to Calven.
