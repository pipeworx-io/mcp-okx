# @pipeworx/okx

[OKX v5](https://www.okx.com/docs-v5/) MCP — keyless public market endpoints.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1558+ live data sources.

## Tools

- `instruments(instType, uly?, instFamily?, instId?)` — list instruments (`SPOT|MARGIN|SWAP|FUTURES|OPTION`)
- `ticker(instId)` — single ticker (e.g. `BTC-USDT`)
- `tickers(instType, uly?, instFamily?)` — tickers by type
- `order_book(instId, sz?)` — orderbook
- `candles(instId, bar?, after?, before?, limit?)` — OHLC (bar `1m|3m|5m|15m|30m|1H|2H|4H|6H|12H|1D|1W|1M|3M`)
- `trades(instId, limit?)` — recent trades
- `market_24hr(instId)` — 24h ticker
- `index_tickers(quoteCcy?, instId?)` — index tickers
- `funding_rate(instId)` — current funding (perpetual swaps)
- `funding_rate_history(instId, before?, after?, limit?)` — historical funding
- `mark_price(instType, uly?, instId?)` — mark price
- `perp_metrics(instId, period?, buckets?)` — one call for funding rate + open interest + taker buy/sell (CVD) + long/short account ratio
- `open_interest(instId, instType?)` — contracts outstanding, coin size, USD notional
- `taker_volume(instId, period?, buckets?, unit?)` — taker buy vs sell volume, buy/sell ratio and CVD across the window
- `long_short_ratio(instId, period?, buckets?)` — ratio of accounts long to accounts short
- `time()` — system time
- `status()` — system status

## Data source

`https://www.okx.com/api/v5/public` and `/market`

## Symbols

The four derivatives tools above accept a perpetual written in any common house
style — `MASKUSDT` (Binance style), `MASK`, `MASK/USDT`, `MASK-USDT` and
`MASK-USDT-SWAP` all resolve to the OKX contract `MASK-USDT-SWAP`. Every response
names the venue and the resolved `instId`, because a coin quoted on Binance or
Bybit is answered here with OKX's own contract and the numbers differ between
venues. Binance's perpetual endpoints refuse requests from Cloudflare egress
(403), so a Binance-specific taker buy/sell breakdown is not available from us.

An unknown contract comes back as `{found: false, reason: "instrument_not_found"}`
with the resolved `instId` and a hint, rather than an empty success — OKX itself
answers a bad instrument with HTTP 200 and `code: "51001"`.

## Column order (taker volume)

`/rubik/stat/taker-volume-contract` returns `[ts, sellVol, buyVol]` — sell first.
Verified 2026-08-22 by bucketing the live `/market/trades` tape for
`MASK-USDT-SWAP` into 5-minute bins and matching it against the endpoint
exactly. Reading the columns the other way round silently inverts the sign of CVD.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "okx": {
      "url": "https://gateway.pipeworx.io/okx/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/okx/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1558+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "okx": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-okx"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-okx
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Okx data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
