# @pipeworx/okx

[OKX v5](https://www.okx.com/docs-v5/) MCP — keyless public market endpoints.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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
- `time()` — system time
- `status()` — system status

## Data source

`https://www.okx.com/api/v5/public` and `/market`

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Okx data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
