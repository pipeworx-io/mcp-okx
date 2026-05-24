interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * OKX v5 public MCP.
 */


const BASE = 'https://www.okx.com/api/v5';
const UA = 'pipeworx-mcp-okx/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'instruments',
    description: 'List instruments.',
    inputSchema: { type: 'object', properties: { instType: { type: 'string' }, uly: { type: 'string' }, instFamily: { type: 'string' }, instId: { type: 'string' } }, required: ['instType'] },
  },
  { name: 'ticker', description: 'Single ticker.', inputSchema: { type: 'object', properties: { instId: { type: 'string' } }, required: ['instId'] } },
  {
    name: 'tickers',
    description: 'Tickers by type.',
    inputSchema: { type: 'object', properties: { instType: { type: 'string' }, uly: { type: 'string' }, instFamily: { type: 'string' } }, required: ['instType'] },
  },
  { name: 'order_book', description: 'Orderbook.', inputSchema: { type: 'object', properties: { instId: { type: 'string' }, sz: { type: 'number' } }, required: ['instId'] } },
  {
    name: 'candles',
    description: 'OHLC candles.',
    inputSchema: { type: 'object', properties: { instId: { type: 'string' }, bar: { type: 'string' }, after: { type: 'string' }, before: { type: 'string' }, limit: { type: 'number' } }, required: ['instId'] },
  },
  { name: 'trades', description: 'Recent trades.', inputSchema: { type: 'object', properties: { instId: { type: 'string' }, limit: { type: 'number' } }, required: ['instId'] } },
  { name: 'market_24hr', description: '24h ticker.', inputSchema: { type: 'object', properties: { instId: { type: 'string' } }, required: ['instId'] } },
  { name: 'index_tickers', description: 'Index tickers.', inputSchema: { type: 'object', properties: { quoteCcy: { type: 'string' }, instId: { type: 'string' } } } },
  { name: 'funding_rate', description: 'Current funding rate.', inputSchema: { type: 'object', properties: { instId: { type: 'string' } }, required: ['instId'] } },
  {
    name: 'funding_rate_history',
    description: 'Historical funding rate.',
    inputSchema: { type: 'object', properties: { instId: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, limit: { type: 'number' } }, required: ['instId'] },
  },
  {
    name: 'mark_price',
    description: 'Mark price.',
    inputSchema: { type: 'object', properties: { instType: { type: 'string' }, uly: { type: 'string' }, instId: { type: 'string' } }, required: ['instType'] },
  },
  { name: 'time', description: 'System time.', inputSchema: { type: 'object', properties: {} } },
  { name: 'status', description: 'System status.', inputSchema: { type: 'object', properties: {} } },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const get = async (path: string, params?: Record<string, unknown>) => {
    const p = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) if (v != null) p.set(k, String(v));
    const url = `${BASE}${path}${[...p].length ? `?${p}` : ''}`;
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (!res.ok) throw new Error(`OKX: ${res.status}`);
    return res.json();
  };
  const reqStr = (k: string, ex: string) => {
    const v = args[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${k}" is missing. Pass a string like ${ex}.`);
    return v;
  };
  switch (name) {
    case 'instruments':
      return get('/public/instruments', { instType: reqStr('instType', '"SPOT"'), uly: args.uly, instFamily: args.instFamily, instId: args.instId });
    case 'ticker':
      return get('/market/ticker', { instId: reqStr('instId', '"BTC-USDT"') });
    case 'tickers':
      return get('/market/tickers', { instType: reqStr('instType', '"SPOT"'), uly: args.uly, instFamily: args.instFamily });
    case 'order_book':
      return get('/market/books', { instId: reqStr('instId', '"BTC-USDT"'), sz: args.sz });
    case 'candles':
      return get('/market/candles', { instId: reqStr('instId', '"BTC-USDT"'), bar: args.bar, after: args.after, before: args.before, limit: args.limit });
    case 'trades':
      return get('/market/trades', { instId: reqStr('instId', '"BTC-USDT"'), limit: args.limit });
    case 'market_24hr':
      return get('/market/index-tickers', { instId: reqStr('instId', '"BTC-USDT"') });
    case 'index_tickers':
      return get('/market/index-tickers', { quoteCcy: args.quoteCcy, instId: args.instId });
    case 'funding_rate':
      return get('/public/funding-rate', { instId: reqStr('instId', '"BTC-USDT-SWAP"') });
    case 'funding_rate_history':
      return get('/public/funding-rate-history', { instId: reqStr('instId', '"BTC-USDT-SWAP"'), before: args.before, after: args.after, limit: args.limit });
    case 'mark_price':
      return get('/public/mark-price', { instType: reqStr('instType', '"SWAP"'), uly: args.uly, instId: args.instId });
    case 'time':
      return get('/public/time');
    case 'status':
      return get('/system/status');
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
