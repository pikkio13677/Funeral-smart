# FUNERAL SMART — Matrice tenant e integrità referenziale

Questo documento completa la ricognizione. È progettazione soltanto: nessuna query o tabella in produzione viene modificata.

## Tabelle private e relazioni

| Tabella | Tenant richiesto | Relazioni da vincolare allo stesso tenant |
|---|---|---|
| customers | sì | funeral_cases.customer_id, invoices.customer_id |
| funeral_cases | sì | customer_id, stock_movements.case_id, tasks.case_id, invoices.case_id |
| staff | sì | tasks.assigned_to |
| vehicles | sì | eventuali assegnazioni future a pratiche/personale |
| inventory_items | sì | stock_movements.item_id |
| stock_movements | sì | item_id, case_id |
| tasks | sì | case_id, assigned_to |
| invoices | sì | case_id, customer_id, payments.invoice_id |
| payments | sì | invoice_id |

## Vincoli compositi da valutare

Per impedire collegamenti cross-tenant anche in caso di bug applicativo, le tabelle referenziate dovranno esporre una chiave univoca composta `(company_id, id)`. Le tabelle figlie useranno FK composte:
- funeral_cases(company_id, customer_id) → customers(company_id, id)
- invoices(company_id, customer_id) → customers(company_id, id)
- invoices(company_id, case_id) → funeral_cases(company_id, id)
- stock_movements(company_id, item_id) → inventory_items(company_id, id)
- stock_movements(company_id, case_id) → funeral_cases(company_id, id)
- tasks(company_id, case_id) → funeral_cases(company_id, id)
- tasks(company_id, assigned_to) → staff(company_id, id)
- payments(company_id, invoice_id) → invoices(company_id, id)

Le FK nullable devono mantenere la semantica attuale quando il riferimento è NULL. Il disegno definitivo dovrà essere verificato con PostgreSQL e con dati di prova, non solo letto staticamente.

## Unicità oggi globale da rivedere

Nel file `gestionale.sql`:
- `funeral_cases.case_code UNIQUE`
- `vehicles.plate UNIQUE`
- `inventory_items.sku UNIQUE`
- `invoices.invoice_number UNIQUE`

Decisione proposta per SaaS: unicità entro azienda, non globale, dopo verifica che l'applicazione e i documenti permettano codici uguali tra aziende. La migrazione dovrà prima rilevare eventuali duplicati per azienda, creare gli indici unici composti e solo in una fase successiva rimuovere i vecchi vincoli globali. Non rimuovere i vincoli prima che i nuovi siano attivi.

## Dati di marketplace e piattaforma

- `service_types`: catalogo globale, nessun tenant.
- `providers`, `provider_services`, `price_lists`: directory/listini pubblici; il provider può corrispondere a un'impresa registrata, ma la relazione va esplicitata prima di unire il dominio marketplace al gestionale.
- `provider_applications`, `inquiries`: richieste di contatto/candidature della piattaforma, non dati gestionali privati di un tenant.
- `app_users`: identità globale.
- `app_sessions`: sessione globale con contesto aziendale attivo da aggiungere tramite migrazione separata e selezione verificata.
- `audit_log`: separare eventi piattaforma da eventi aziendali; per eventi aziendali registrare company_id e applicare autorizzazione anche alla lettura.

## Regole di accesso raccomandate

- Platform admin: accesso amministrativo globale, con audit esplicito.
- Company admin: gestione utenti/membership solo nella propria azienda, senza privilegi globali.
- Manager/operator/warehouse/accounting: permessi per membership attiva e per endpoint.
- Nessun ruolo globale `admin` deve diventare automaticamente amministratore di ogni nuova azienda.
- Una membership revocata o sospesa deve bloccare immediatamente richieste e sessioni che usano quell'azienda.

## Controlli di migrazione sul clone

Prima e dopo il backfill, registrare conteggi per ogni tabella privata. Controllare:
1. nessun record privato con company_id NULL al termine del backfill;
2. nessuna relazione figlia con tenant diverso dal padre;
3. nessun pagamento orfano rispetto alla fattura;
4. nessun movimento magazzino riferito ad articolo o pratica di altra azienda;
5. nessun task assegnato a personale di altra azienda;
6. unicità dei codici per azienda;
7. restore completo del database di prova e confronto dei conteggi.
