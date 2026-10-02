import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { matchOdooQuestion, answerOdooQuestion } from './lib/odoo-questions.ts';
import { enqueueAgentMessage } from './lib/agent-followups.ts';
const cfg = JSON.parse(fs.readFileSync(process.env.CFG, 'utf8'));
const text = await answerOdooQuestion(matchOdooQuestion('شو ناقص من المخزون'),
  { odoo: { url: cfg.ODOO_URL, db: cfg.ODOO_DB, username: cfg.ODOO_USERNAME, apiKey: cfg.ODOO_API_KEY },
    currencyLabel: cfg.ODOO_CURRENCY_LABEL }, Date.now());
console.log('--- what will be sent ---\n' + text + '\n-------------------------');
const db = new DatabaseSync(process.env.DB);
enqueueAgentMessage(db, { toUser: 'group', text }, Date.now());
console.log('queued for the group; the bridge sends it within a minute.');
