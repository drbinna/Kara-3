import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { listOpenTickets, getTicket, updateTicket, MODE } from './zendesk.js';
import { getPending, setPending, clearPending, setLastCommit } from './gate.js';

const VALID_STATUS = ['open', 'pending', 'hold', 'solved'];

const listOpen = tool(
  'list_open_tickets',
  'List the open Zendesk tickets (id, subject, requester, status, priority).',
  {},
  async () => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await listOpenTickets()) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Zendesk error: ${err.message}` }], isError: true };
    }
  },
  { annotations: { readOnlyHint: true } }
);

const getOne = tool(
  'get_ticket',
  'Get one Zendesk ticket by id, including its description, so you can read it before acting.',
  { id: z.number().describe('Ticket id') },
  async ({ id }) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await getTicket(id)) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
  },
  { annotations: { readOnlyHint: true } }
);

const stage = tool(
  'stage_ticket_update',
  `Stage a change to a ticket WITHOUT sending it to Zendesk. Records the intended new status and/or
public reply, then returns a summary you must read back to the user. Always call this first, then ask
the user to confirm out loud. Do not call commit_ticket_update in the same turn.`,
  {
    id: z.number().describe('Ticket id'),
    status: z.string().default('').describe(`New status, one of: ${VALID_STATUS.join(', ')} (optional)`),
    comment: z.string().default('').describe('Public reply to post on the ticket (optional)'),
  },
  async ({ id, status, comment }) => {
    if (status && !VALID_STATUS.includes(status)) {
      return { content: [{ type: 'text', text: `Invalid status "${status}".` }], isError: true };
    }
    if (!status && !comment) {
      return { content: [{ type: 'text', text: 'Nothing to change: give a status and/or a comment.' }], isError: true };
    }
    let subject = `#${id}`;
    try {
      const t = await getTicket(id);
      subject = t.subject || subject;
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    setPending({ id, status, comment, subject });
    const parts = [];
    if (status) parts.push(`set status to ${status}`);
    if (comment) parts.push(`post the reply "${comment}"`);
    return {
      content: [
        {
          type: 'text',
          text: `STAGED for ticket #${id} (${subject}): ${parts.join(' and ')}. Read this back and ask the user to confirm out loud before committing.`,
        },
      ],
    };
  },
  { annotations: { readOnlyHint: true } } // staging touches no external system
);

const commit = tool(
  'commit_ticket_update',
  `Send the staged change to Zendesk. Only call this AFTER the user has confirmed out loud in a later
turn. It is refused if nothing is staged or the user has not confirmed this turn.`,
  { id: z.number().describe('Ticket id to commit — must match the staged ticket') },
  async ({ id }) => {
    const p = getPending();
    if (!p) return { content: [{ type: 'text', text: 'Nothing is staged to commit.' }], isError: true };
    if (Number(id) !== Number(p.id)) {
      return { content: [{ type: 'text', text: `The staged ticket is #${p.id}, not #${id}.` }], isError: true };
    }
    try {
      await updateTicket(p.id, { status: p.status || undefined, comment: p.comment || undefined });
      setLastCommit({ id: p.id, status: p.status, subject: p.subject });
      clearPending();
      return { content: [{ type: 'text', text: `Committed ticket #${p.id} to Zendesk.` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Zendesk update failed: ${err.message}` }], isError: true };
    }
  },
  { annotations: { readOnlyHint: false, destructiveHint: true } }
);

export const ticketServer = createSdkMcpServer({
  name: 'zendesk',
  version: '1.0.0',
  tools: [listOpen, getOne, stage, commit],
});

// Read + stage are safe to auto-approve. Commit is deliberately NOT here, so it
// routes through canUseTool where the spoken-confirmation gate lives.
export const READ_TICKET_TOOLS = [
  'mcp__zendesk__list_open_tickets',
  'mcp__zendesk__get_ticket',
  'mcp__zendesk__stage_ticket_update',
];
export const COMMIT_TICKET_TOOL = 'mcp__zendesk__commit_ticket_update';
export const ZENDESK_MODE = MODE;
