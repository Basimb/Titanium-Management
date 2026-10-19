/** Deployment facts from inspected code and a read-only version_info call, 2026-10-13. */
export function secretaryOdooKnowledge(text: string) {
  if (!/odoo|اودو|أودو|مخزون|ستوك|جرد|فاتور|مرتجع|مبيعات|تحويل|صلاحية|رصيد|سجل|سجّل|تسجيل|كتابة/i.test(text)) return undefined;
  return {
    verifiedVersion: '16.0', verifiedAt: '2026-10-13', scope: 'deployment-reference-not-permissions',
    currentAminTools: 'The inspected Odoo query client supports validated read-only search_count, search_read and read_group. It has no create/write/unlink. Do not claim that a write, posting, validation or reconciliation happened.',
    existingAccess: 'Read using the requesting employee personal Odoo credentials and permitted records. A department/title does not grant stock or accounting permissions. No owner-credential fallback for an employee. Model/field availability must come from the current validated catalog, not memorized standard names.',
    analysis: 'Use the same company, branch/location, date window, timezone, unit of measure, currency, state and return treatment across comparisons. Say the timestamp/source and limitations. Separate available/on-hand/reserved stock, receipt vs sale, gross revenue vs contribution, invoice vs customer, and draft vs posted/completed record. Zero returned rows is not proof of zero demand during a stockout.',
    proposedWrites: 'For a requested write identify the exact target record, requested fields, employee authority, current state and expected result; show a bounded draft. Use an actual approved IDARA/Odoo action only if available; otherwise state the missing capability and offer a draft, never substitute a task comment for an Odoo stock/accounting mutation. Re-read and review the committed result before reporting success. Avoid duplicate retries when status is uncertain; retain an audit reference.',
    standardRules: [
      'Odoo 16 distinguishes model access rights and record rules. Validate the requested operation and records as the authenticated user; never bypass them with an owner fallback or raw database write.',
      'An inventory count and applying an inventory adjustment are different steps. A new default counted quantity of zero is not evidence that physical stock is zero. Review the count, location, unit and difference before applying; use the real application confirmation workflow.',
      'Lot/serial tracking supports tracing product batches and expiration information. Do not infer the expiry of every unit from a product-level label or apply an unverified batch date to all stock.'
    ],
    sources: ['Inspected lib/odoo-client.ts, lib/odoo-explore.ts, lib/team-chat-backend.ts', 'Read-only /web/webclient/version_info on the configured Dawatech server',
      'https://www.odoo.com/documentation/16.0/developer/reference/backend/security.html',
      'https://www.odoo.com/documentation/16.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/count_products.html',
      'https://www.odoo.com/documentation/16.0/applications/inventory_and_mrp/inventory/product_management/product_tracking/lots.html'],
    coverage: 'Deployment and existing-tool rules verified. This is not all Odoo 16 documentation and does not establish every Dawatech customization.'
  };
}
