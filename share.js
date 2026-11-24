// WhatsApp: invoice text + link in one call; reminder for a customer debt.
import { fail } from './errors.js';
import { renderInvoice, renderReminder, waLink } from './invoice-text.js';
import { settingsApi } from './settings.js';
import { partyBalance } from './queries.js';

export function shareApi(ctx) {
  const { store } = ctx;
  const settings = () => settingsApi(ctx).get();
  return {
    // -> { text, link }  (link = null when the invoice has no party with a phone)
    async invoiceMessage(idOrNo) {
      /* any invoice reader */ if (!['view_invoices', 'quick_sale', 'return_customer', 'return_supplier', 'collect_debt', 'pay_supplier'].some((k) => ctx.access.can(k))) ctx.access.require('view_invoices');
      const s = await settings();
      return store.transaction(async (tx) => {
        const inv = (await tx.find('invoices', i => i.id === idOrNo || i.invoice_no === idOrNo))[0];
        if (!inv) fail('INVOICE_NOT_FOUND', 'Invoice not found');
        const detail = inv.type === 'quick_sale' ? (await tx.find('invoices', d => d.type === 'quick_detail' && d.parent_invoice_id === inv.id))[0] : null;
        const lines = (await tx.find('invoice_lines', l => l.invoice_id === (detail || inv).id)).sort((a, b) => a.line_no - b.line_no);
        const custId = inv.customer_id || detail?.customer_id;
        const party = custId ? await tx.get('customers', custId) : inv.supplier_id ? await tx.get('suppliers', inv.supplier_id) : null;
        const parent = inv.parent_invoice_id ? await tx.get('invoices', inv.parent_invoice_id) : null;
        const text = renderInvoice({ invoice: inv, lines, party, parentNo: parent?.invoice_no, settings: s });
        return { text, link: party ? waLink(party.phone_norm, text) : null, invoice_id: inv.id };
      });
    },
    async markSent(invoiceId) {
      return store.transaction(async (tx) => { await tx.update('invoices', invoiceId, { sent_at: ctx.now().toISOString(), updated_at: ctx.now().toISOString() }); });
    },
    // one-tap debt reminder (records the date of the last reminder)
    async reminder(customerId) {
      ctx.access.require('send_reminder');
      const s = await settings();
      return store.transaction(async (tx) => {
        const c = await tx.get('customers', customerId);
        if (!c) fail('PARTY_NOT_FOUND', 'Customer not found');
        const balance = await partyBalance(tx, 'customer_id', c.id);
        if (balance <= 0) fail('NO_DEBT', 'This customer owes nothing');
        const text = renderReminder({ party: c, balance, settings: s });
        await tx.update('customers', c.id, { last_reminder_at: ctx.now().toISOString(), updated_at: ctx.now().toISOString() });
        return { text, link: waLink(c.phone_norm, text), balance };
      });
    },
  };
}
