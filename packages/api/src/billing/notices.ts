/**
 * The messages that ask a person to act on Billing, sent to the same address as the data of the
 * electronic invoices (`BILLING_INVOICE_TO`), in Italian, in plain text.
 *
 * Each is about something the code will not decide alone: a second subscription that is taking
 * money (which one to cancel, and the refund), fiscal data of a customer with a subscription
 * that changed (for information: Stripe Tax computes the next invoices from the new data), a contract account that
 * still has a subscription (which should not exist), the invoices a closed subscription left
 * unpaid, and a claim of overage that keeps failing. None carries a secret, a card or a session.
 */
import type { MailMessage } from '../mail/index.js';

const DASHBOARD = 'https://dashboard.stripe.com';

export function duplicateSubscriptionMessage(
  to: string,
  data: {
    accountId: string;
    accountName: string | null;
    customer: string;
    kept: string;
    duplicate: string;
  },
): MailMessage {
  return {
    to,
    subject: `Abbonamento doppio da annullare: ${data.accountName ?? data.accountId}`,
    text: [
      'ATTENZIONE: questo account ha due abbonamenti Stripe vivi. Pagano entrambi.',
      '',
      `Account Bookrail: ${data.accountId}${data.accountName === null ? '' : ` (${data.accountName})`}`,
      `Cliente Stripe: ${data.customer}`,
      `Abbonamento registrato, da tenere: ${data.kept}`,
      `Abbonamento doppio, da annullare e rimborsare: ${data.duplicate}`,
      '',
      "Bookrail non ha applicato il secondo: il piano dell'account segue il primo.",
      `Nel cruscotto di Stripe (${DASHBOARD}/subscriptions/${data.duplicate}): annullare subito`,
      "l'abbonamento doppio e rimborsare quanto ha incassato.",
      '',
    ].join('\n'),
  };
}

export function fiscalDataChangedMessage(
  to: string,
  data: {
    accountId: string;
    accountName: string | null;
    customer: string;
    subscription: string | null;
    what: readonly string[];
  },
): MailMessage {
  return {
    to,
    subject: `Dati fiscali cambiati: ${data.accountName ?? data.accountId}`,
    text: [
      'Per informazione: i dati fiscali di un cliente con un abbonamento sono cambiati su Stripe.',
      "Stripe Tax calcola l'imposta delle prossime fatture dai dati nuovi da sé; da verificare è la",
      'fattura elettronica da emettere, con il regime giusto.',
      '',
      `Account Bookrail: ${data.accountId}${data.accountName === null ? '' : ` (${data.accountName})`}`,
      `Cliente Stripe: ${data.customer} (${DASHBOARD}/customers/${data.customer})`,
      `Abbonamento: ${data.subscription ?? '(nessuno)'}`,
      `Cosa è cambiato: ${data.what.length === 0 ? 'non indicato da Stripe' : data.what.join(', ')}`,
      '',
    ].join('\n'),
  };
}

/** The subscription on file ended while the duplicate still takes money: a second reminder. */
export function duplicateEndedMessage(
  to: string,
  data: {
    accountId: string;
    accountName: string | null;
    customer: string;
    ended: string;
    duplicate: string;
  },
): MailMessage {
  return {
    to,
    subject: `Abbonamento doppio ancora attivo: ${data.accountName ?? data.accountId}`,
    text: [
      "ATTENZIONE: l'abbonamento registrato di questo account è finito, ma il doppione segnalato",
      'prima è ancora vivo e incassa. Bookrail lo ha applicato: il piano ora segue il doppione.',
      '',
      `Account Bookrail: ${data.accountId}${data.accountName === null ? '' : ` (${data.accountName})`}`,
      `Cliente Stripe: ${data.customer}`,
      `Abbonamento finito: ${data.ended}`,
      `Doppione ancora vivo: ${data.duplicate} (${DASHBOARD}/subscriptions/${data.duplicate})`,
      '',
      'Se il cliente voleva chiudere, annullare anche il doppione e rimborsare quanto non dovuto.',
      '',
    ].join('\n'),
  };
}

/** The invoices a subscription closed for non payment left open. */
export function unpaidInvoicesMessage(
  to: string,
  data: {
    accountId: string;
    accountName: string | null;
    customer: string;
    invoices: readonly {
      id: string;
      number: string | null;
      amountRemaining: number;
      currency: string;
      hostedInvoiceUrl: string | null;
    }[];
  },
): MailMessage {
  return {
    to,
    subject: `Fatture non pagate dopo la chiusura: ${data.accountName ?? data.accountId}`,
    text: [
      "L'abbonamento di questo account è stato chiuso per mancato pagamento, e queste fatture",
      'restano aperte. Stripe non le riscuote più; al cliente è stato mandato il link per pagarle,',
      'la dashboard le mostra, e un nuovo Checkout è rifiutato finché restano aperte. Nessuna è',
      'stata annullata: annullarle o dichiararle inesigibili è una decisione da prendere a mano.',
      '',
      `Account Bookrail: ${data.accountId}${data.accountName === null ? '' : ` (${data.accountName})`}`,
      `Cliente Stripe: ${data.customer} (${DASHBOARD}/customers/${data.customer})`,
      '',
      ...data.invoices.map(
        (invoice) =>
          `  - ${invoice.number ?? invoice.id}: ${importoItaliano(invoice.amountRemaining, invoice.currency)}, ${invoice.hostedInvoiceUrl ?? `${DASHBOARD}/invoices/${invoice.id}`}`,
      ),
      '',
    ].join('\n'),
  };
}

/** A claim of overage that fails every time it is taken again. */
export function overageStuckMessage(
  to: string,
  data: {
    accountId: string;
    customer: string | null;
    month: string;
    origin: 'renewal' | 'final';
    attempts: number;
    error: string;
  },
): MailMessage {
  return {
    to,
    subject: `Eccedenza di ${data.month} non fatturata dopo ${String(data.attempts)} tentativi`,
    text: [
      "ATTENZIONE: l'eccedenza di un mese non riesce a entrare in fattura. Bookrail riprova ogni",
      'giorno, ma dopo cinque tentativi serve uno sguardo.',
      '',
      `Account Bookrail: ${data.accountId}`,
      `Cliente Stripe: ${data.customer ?? '(nessuno)'}`,
      `Mese: ${data.month} (${data.origin === 'final' ? 'ultimo mese di un abbonamento finito' : 'rinnovo'})`,
      `Ultimo errore: ${data.error}`,
      '',
      'La riga è nella tabella billing_overages, con gli importi da fatturare.',
      '',
    ].join('\n'),
  };
}

/** Cents as an Italian amount: `8455` in eur is `84,55 EUR`. */
function importoItaliano(cents: number, currency: string): string {
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${whole},${String(cents % 100).padStart(2, '0')} ${currency.toUpperCase()}`;
}

export function enterpriseSubscriptionMessage(
  to: string,
  data: {
    accountId: string;
    accountName: string | null;
    customer: string;
    month: string;
  },
): MailMessage {
  return {
    to,
    subject: `Account Enterprise con un abbonamento Stripe: ${data.accountName ?? data.accountId}`,
    text: [
      'Un account sul piano Enterprise, che è un contratto, ha ancora un abbonamento Stripe che',
      `si rinnova. Bookrail non ha aggiunto eccedenze per ${data.month}.`,
      '',
      `Account Bookrail: ${data.accountId}${data.accountName === null ? '' : ` (${data.accountName})`}`,
      `Cliente Stripe: ${data.customer} (${DASHBOARD}/customers/${data.customer})`,
      '',
      "Annullare l'abbonamento nel cruscotto di Stripe, se non deve esistere.",
      '',
    ].join('\n'),
  };
}
