/**
 * The messages for whoever issues the electronic invoices: one for every paid invoice, and the
 * list of a month on the second day of the next.
 *
 * Stripe collects the money and sends the customer a receipt; the invoice that counts for the
 * Italian tax authority is an electronic invoice issued from the accounting software of the
 * company, by a person, for now. These messages carry everything that person needs, in Italian,
 * in plain text, and the same data stays in `billing_invoices`, where an automation will read it
 * the day there is one.
 *
 * An EU VAT number that Stripe could not verify against VIES is said at the top of the message:
 * a reverse charge invoice to a number that is not valid is an invoice with the wrong tax.
 */
import type { MailMessage } from '../mail/index.js';
import type { VatTreatment } from './catalog.js';

export interface InvoiceLineData {
  description: string | null;
  /** Cents, VAT excluded. */
  amount: number;
  taxAmount: number;
  /** `22`, `0`, or `null` when Stripe Tax computed no tax entry for the line. */
  taxRatePercent: number | null;
  /** Stripe Tax's reason for the tax of the line (`standard_rated`, `reverse_charge`, ...). */
  taxabilityReason?: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface InvoiceData {
  stripeInvoiceId: string;
  number: string | null;
  hostedInvoiceUrl: string | null;
  paidAt: string;
  currency: string;
  accountId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  taxIdType: string | null;
  taxIdValue: string | null;
  taxIdVerification: string | null;
  country: string | null;
  address: Record<string, string | null>;
  sdiOrPec: string | null;
  /**
   * The treatment of the VAT, from the taxes Stripe Tax computed on the invoice (a
   * `reverse_charge` reason, or a tax charged), not from the country of the address.
   */
  vatTreatment: VatTreatment;
  /** The reasons Stripe Tax gave, all of them, for the record. */
  taxabilityReasons?: readonly string[];
  /** Why the rates applied and the country disagree, when they do; said first in the message. */
  vatWarning?: string | null;
  lines: InvoiceLineData[];
  subtotal: number;
  tax: number;
  total: number;
}

/** Cents as an Italian amount: `353800` in eur is `3.538,00 EUR`. */
export function importo(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${whole},${String(abs % 100).padStart(2, '0')} ${currency.toUpperCase()}`;
}

/** The date of an instant in the calendar of the Italian accounts. */
export function dataItaliana(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** What the electronic invoice has to say about the VAT, by the country of the customer. */
export function regimeIva(treatment: VatTreatment): { regime: string; dicitura: string } {
  switch (treatment) {
    case 'it_vat':
      return { regime: 'IVA ordinaria, cliente italiano', dicitura: 'nessuna' };
    case 'eu_reverse_charge':
      return {
        regime: 'Operazione intracomunitaria B2B, IVA 0 %',
        dicitura:
          'Operazione non soggetta, inversione contabile (reverse charge), art. 7-ter DPR 633/72',
      };
    case 'outside_eu':
      return {
        regime: 'Servizio a cliente extra UE, IVA 0 %',
        dicitura: 'Operazione non soggetta ad IVA, art. 7-ter DPR 633/72',
      };
  }
}

/** Is the tax id one that VIES should have confirmed, and did it not? */
export function unverifiedEuVat(invoice: InvoiceData): boolean {
  return invoice.vatTreatment === 'eu_reverse_charge' && invoice.taxIdVerification !== 'verified';
}

function indirizzo(address: Record<string, string | null>): string {
  const parts = [
    address.line1,
    address.line2,
    [address.postal_code, address.city, address.state === null ? null : address.state]
      .filter((part) => part !== null && part !== undefined && part !== '')
      .join(' '),
    address.country,
  ].filter((part) => part !== null && part !== undefined && part !== '');
  return parts.length === 0 ? '(non fornito)' : parts.join(', ');
}

function aliquota(percent: number | null): string {
  return percent === null ? 'nessuna' : `${String(percent).replace('.', ',')} %`;
}

export function invoiceDataMessage(to: string, invoice: InvoiceData): MailMessage {
  const cliente = invoice.customerName ?? invoice.customerEmail ?? 'cliente senza nome';
  const { regime, dicitura } = regimeIva(invoice.vatTreatment);
  const warning = [
    ...(invoice.vatWarning === null || invoice.vatWarning === undefined
      ? []
      : [`ATTENZIONE: ${invoice.vatWarning}`, '']),
    ...(unverifiedEuVat(invoice)
      ? [
          `ATTENZIONE: la partita IVA UE non risulta verificata da VIES (stato Stripe: ${invoice.taxIdVerification ?? 'nessuna partita IVA'}).`,
          'Verificarla prima di emettere la fattura in reverse charge.',
          '',
        ]
      : []),
  ];
  const lines = invoice.lines.map((line) => {
    const periodo =
      line.periodStart === null || line.periodEnd === null
        ? ''
        : `, periodo ${dataItaliana(line.periodStart)} - ${dataItaliana(line.periodEnd)}`;
    const motivo =
      line.taxabilityReason === null || line.taxabilityReason === undefined
        ? ''
        : ` (${line.taxabilityReason})`;
    return `  - ${line.description ?? '(senza descrizione)'}: imponibile ${importo(line.amount, invoice.currency)}, aliquota ${aliquota(line.taxRatePercent)}${motivo}, IVA ${importo(line.taxAmount, invoice.currency)}${periodo}`;
  });
  return {
    to,
    subject: `Fattura da emettere: ${cliente} ${importo(invoice.total, invoice.currency)}`,
    text: [
      ...warning,
      'Un incasso di Bookrail da fatturare elettronicamente.',
      '',
      `Data dell'incasso: ${dataItaliana(invoice.paidAt)}`,
      `Fattura Stripe: ${invoice.number ?? invoice.stripeInvoiceId}`,
      `Link: ${invoice.hostedInvoiceUrl ?? '(nessuno)'}`,
      `Account Bookrail: ${invoice.accountId ?? '(non collegato)'}`,
      '',
      'Cliente',
      `  Ragione sociale: ${invoice.customerName ?? '(non fornita)'}`,
      `  Partita IVA o identificativo fiscale: ${invoice.taxIdValue ?? '(non fornito)'}${invoice.taxIdType === null ? '' : ` (${invoice.taxIdType})`}`,
      `  Verifica di Stripe: ${invoice.taxIdVerification ?? 'non disponibile'}`,
      `  Paese: ${invoice.country ?? '(non fornito)'}`,
      `  Indirizzo: ${indirizzo(invoice.address)}`,
      `  Codice SdI o PEC: ${invoice.sdiOrPec ?? '(non fornito)'}`,
      `  Email: ${invoice.customerEmail ?? '(non fornita)'}`,
      '',
      'Righe',
      ...lines,
      '',
      `Imponibile: ${importo(invoice.subtotal, invoice.currency)}`,
      `IVA: ${importo(invoice.tax, invoice.currency)}`,
      `Totale: ${importo(invoice.total, invoice.currency)}`,
      '',
      `Regime IVA: ${regime}`,
      `Calcolo dell'imposta: Stripe Tax${invoice.taxabilityReasons === undefined || invoice.taxabilityReasons.length === 0 ? '' : `, motivi ${invoice.taxabilityReasons.join(', ')}`}`,
      `Dicitura da riportare in fattura: ${dicitura}`,
      '',
      'Gli stessi dati sono nella tabella billing_invoices.',
      '',
    ].join('\n'),
  };
}

export interface MonthlyInvoiceRow {
  stripeInvoiceId: string;
  number: string | null;
  paidAt: string;
  customerName: string | null;
  taxIdValue: string | null;
  taxIdVerification: string | null;
  country: string | null;
  sdiOrPec: string | null;
  vatTreatment: VatTreatment;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  hostedInvoiceUrl: string | null;
}

const MESI = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];

/** `2026-09` as `settembre 2026`. */
export function meseItaliano(month: string): string {
  const [year, number] = month.split('-');
  return `${MESI[Number(number) - 1] ?? month} ${year ?? ''}`.trim();
}

/**
 * A CSV field, quoted when it has to be: separator `;`, as an Italian spreadsheet expects.
 *
 * A field that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with an
 * apostrophe, which a spreadsheet shows as text: the legal name is typed by the customer in the
 * checkout, and `=HYPERLINK(...)` there must not become a formula when the file is opened.
 */
export function campo(value: string | null): string {
  const raw = value ?? '';
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Cents as a decimal with a comma and no thousands separator: `353800` is `3538,00`. */
function decimale(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${String(Math.floor(abs / 100))},${String(abs % 100).padStart(2, '0')}`;
}

export const CSV_HEADER = [
  'data_incasso',
  'numero_stripe',
  'fattura_stripe',
  'ragione_sociale',
  'partita_iva',
  'verifica_partita_iva',
  'paese',
  'codice_sdi_o_pec',
  'regime_iva',
  'valuta',
  'imponibile',
  'iva',
  'totale',
  'link',
];

export function monthlyInvoiceCsv(rows: readonly MonthlyInvoiceRow[]): string {
  const lines = [CSV_HEADER.join(';')];
  for (const row of rows) {
    // The amounts are written by this function, never by a customer, and a negative one must stay
    // a number: they are the only fields that are not passed through `campo`.
    lines.push(
      [
        campo(dataItaliana(row.paidAt)),
        campo(row.number),
        campo(row.stripeInvoiceId),
        campo(row.customerName),
        campo(row.taxIdValue),
        campo(row.taxIdVerification),
        campo(row.country),
        campo(row.sdiOrPec),
        campo(row.vatTreatment),
        campo(row.currency.toUpperCase()),
        decimale(row.subtotal),
        decimale(row.tax),
        decimale(row.total),
        campo(row.hostedInvoiceUrl),
      ].join(';'),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function monthlyInvoiceListMessage(
  to: string,
  month: string,
  rows: readonly MonthlyInvoiceRow[],
): MailMessage {
  const totale = rows.reduce((sum, row) => sum + row.total, 0);
  const valute = [...new Set(rows.map((row) => row.currency))];
  const unverified = rows.filter(
    (row) => row.vatTreatment === 'eu_reverse_charge' && row.taxIdVerification !== 'verified',
  );
  return {
    to,
    subject: `Incassi di Bookrail di ${meseItaliano(month)}: ${String(rows.length)} fatture da emettere`,
    text: [
      ...(unverified.length === 0
        ? []
        : [
            `ATTENZIONE: ${String(unverified.length)} partite IVA UE non verificate da VIES in questo elenco.`,
            '',
          ]),
      `Gli incassi di ${meseItaliano(month)} (calendario Europe/Rome), uno per riga. Il CSV allegato ha gli stessi dati.`,
      '',
      ...(rows.length === 0
        ? ['Nessun incasso in questo mese.']
        : rows.map(
            (row) =>
              `${dataItaliana(row.paidAt)}  ${row.number ?? row.stripeInvoiceId}  ${row.customerName ?? '(senza nome)'}  ${row.taxIdValue ?? '(senza partita IVA)'}  ${row.country ?? '--'}  ${row.vatTreatment}  ${importo(row.total, row.currency)}`,
          )),
      '',
      ...(valute.length === 1 && valute[0] !== undefined
        ? [`Totale incassato: ${importo(totale, valute[0])}`]
        : []),
      '',
    ].join('\n'),
    attachments: [
      {
        filename: `bookrail-incassi-${month}.csv`,
        content: monthlyInvoiceCsv(rows),
        contentType: 'text/csv; charset=utf-8',
      },
    ],
  };
}
