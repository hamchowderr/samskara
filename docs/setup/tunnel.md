# Exposing your machine with a tunnel

GitHub and Slack deliver events by making HTTPS requests to your server. They
cannot reach `localhost`. A tunnel gives your machine a public HTTPS address
that forwards to the port Samskara listens on.

You need this even when running Samskara entirely for yourself. Both apps store
the address in their configuration, so pick an approach whose address does not
change.

Cloudflare is recommended. ngrok works for a quick test but breaks the Slack
connect flow on the free tier — see below.

## Cloudflare Tunnel

Gives a stable hostname on a domain you control, survives restarts, and serves
no interstitial page.

**Prerequisites — HUMAN:** a Cloudflare account with a domain on it, and
`cloudflared` installed
([instructions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).

### Authenticate — **HUMAN**

```bash
cloudflared tunnel login
```

Opens a browser and asks you to pick the domain. An agent must not run it.

### Create the tunnel

```bash
cloudflared tunnel create samskara
```

Prints a tunnel **ID** — a UUID — and writes a credentials file named after it
under `~/.cloudflared/`. Note both.

### Write a dedicated config file

Create `~/.cloudflared/samskara.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /absolute/path/to/<tunnel-id>.json
ingress:
  - hostname: samskara.example.com
    service: http://localhost:4111
  - service: http_status:404
```

Use a **separate config file**, not the default `config.yml`. `cloudflared`
reads the default config whenever one exists and uses the tunnel ID it finds
there, regardless of which tunnel name you pass on the command line. If you have
ever created another tunnel on this machine, commands meant for this one will
quietly operate on that one instead. Routing DNS this way has pointed a hostname
at the wrong tunnel, which fails later as a `530` with no obvious cause.

### Route DNS

```bash
cloudflared tunnel --config ~/.cloudflared/samskara.yml \
  route dns samskara samskara.example.com
```

Add `--overwrite-dns` if the record already exists.

### Run it

```bash
cloudflared tunnel --config ~/.cloudflared/samskara.yml run
```

On Windows, start it detached so it is not tied to the session that launched it:

```powershell
Start-Process cloudflared -ArgumentList 'tunnel','--config',"$env:USERPROFILE\.cloudflared\samskara.yml",'run' -WindowStyle Hidden
```

### Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://samskara.example.com/auth/me
```

`200` means the tunnel reaches Samskara. `530` means Cloudflare has the DNS
record but no tunnel is connected to it — check that the process is running and
that its config names the tunnel the DNS record points at.

## ngrok

Faster to start, with a limitation that matters.

```bash
ngrok http 4111
```

Prints a public HTTPS address.

**On the free tier, ngrok serves a browser interstitial page before forwarding
any request that looks like it came from a browser.** Server-to-server webhooks
are unaffected, so GitHub and Slack event delivery works. OAuth redirects do
not: the callback arrives in a browser, hits the interstitial, and the flow
stops. Nothing is logged on the Samskara side and no error is shown — the
account link simply never appears.

So ngrok is usable for testing webhook delivery, and not usable for connecting a
Slack account or completing any OAuth flow, unless you are on a paid plan where
the interstitial is disabled.

The free address also changes on every restart, which means re-editing both app
configurations each time.

## Point Samskara at the tunnel

Both variables in `.env`:

```dotenv
MASTRACODE_PUBLIC_URL=https://samskara.example.com
MASTRACODE_CHANNELS_PUBLIC_URL=https://samskara.example.com
```

`MASTRACODE_PUBLIC_URL` is the origin used for OAuth callbacks and for the deep
links the Factory posts back into chat. `MASTRACODE_CHANNELS_PUBLIC_URL` is the
origin used for channel webhooks and the Slack OIDC redirect; it falls back to
`MASTRACODE_PUBLIC_URL` when unset.

Setting `MASTRACODE_PUBLIC_URL` to `http://localhost:4111` works for signing in
on your own machine, but every "View session" link the Factory posts into Slack
will point at `localhost` and resolve for nobody else. Use the tunnel origin for
both unless you have a reason not to.

Restart Samskara after changing either.

## When the address changes

Anything derived from it has to be updated in the same pass:

- **GitHub App** — callback URL and webhook URL
- **Slack app** — Event Subscriptions request URL, Interactivity request URL,
  and the OAuth redirect URL
- **`.env`** — both variables above

A stale Slack request URL shows up as "Your URL didn't respond with the value of
the challenge parameter" when Slack re-verifies it.
