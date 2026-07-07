import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runReadOnlyQuery, listCalendarEvents, DB_SCHEMA_DOC } from './data-store.js';

const queryDatabase = tool(
  'query_database',
  `Run a READ-ONLY SQL query against the app's SQLite database and get rows back as JSON.
Use this for anything about customers, orders, revenue, or order status.
${DB_SCHEMA_DOC}
Only a single SELECT or WITH statement is allowed.`,
  {
    sql: z
      .string()
      .describe('One SELECT statement, e.g. "SELECT status, COUNT(*) FROM orders GROUP BY status".'),
  },
  async ({ sql }) => {
    try {
      const rows = runReadOnlyQuery(sql);
      // Cap the payload so a huge result set can't blow up the spoken reply.
      return { content: [{ type: 'text', text: JSON.stringify(rows).slice(0, 6000) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Query error: ${err.message}` }], isError: true };
    }
  },
  { annotations: { readOnlyHint: true } }
);

const listEvents = tool(
  'list_calendar_events',
  `List the user's calendar events between two dates (inclusive), sorted by start time.
Dates are ISO YYYY-MM-DD. Omit both to get roughly the next week.`,
  {
    from: z.string().default('').describe('Start date YYYY-MM-DD (optional)'),
    to: z.string().default('').describe('End date YYYY-MM-DD (optional)'),
  },
  async ({ from, to }) => {
    try {
      const events = listCalendarEvents({ from, to });
      return { content: [{ type: 'text', text: JSON.stringify(events) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Calendar error: ${err.message}` }], isError: true };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const dataServer = createSdkMcpServer({
  name: 'data',
  version: '1.0.0',
  tools: [queryDatabase, listEvents],
});

// Fully-qualified names: mcp__{serverKey}__{toolName}. The serverKey ("data")
// is set where this server is registered in server.js's mcpServers option.
export const DATA_TOOL_NAMES = ['mcp__data__query_database', 'mcp__data__list_calendar_events'];
