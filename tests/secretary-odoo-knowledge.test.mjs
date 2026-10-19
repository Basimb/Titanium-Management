import test from 'node:test';
import assert from 'node:assert/strict';
import {secretaryOdooKnowledge} from '../lib/secretary-odoo-knowledge.ts';
test('Odoo reference is versioned and cannot represent missing write tools as available',()=>{
 const k=secretaryOdooKnowledge('سجل فرق الجرد في أودو');
 assert.equal(k.verifiedVersion,'16.0');
 assert.match(k.currentAminTools,/no create\/write\/unlink/);
 assert.match(k.existingAccess,/No owner-credential fallback/);
 assert.match(k.proposedWrites,/never substitute a task comment/);
 assert.ok(k.sources.some(s=>s.includes('/documentation/16.0/')));
 assert.match(k.coverage,/not all Odoo 16 documentation/);
 assert.equal(secretaryOdooKnowledge('مرحبا'),undefined);
});
