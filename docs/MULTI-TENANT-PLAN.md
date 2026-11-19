# FUNERAL SMART — Piano multi-azienda (proposta, non applicata)

## Stato e regole di sicurezza

Questo documento definisce il percorso per trasformare FUNERAL SMART in un servizio SaaS multi-azienda.
È una specifica tecnica su un branch separato: **non modifica il database, non cambia il backend in produzione e non abilita ancora nuovi tenant**.

Regole inderogabili:
- La versione attualmente funzionante deve restare disponibile finché test e migrazione non sono superati.
- Nessuna migrazione distruttiva: niente DROP, TRUNCATE o cancellazioni massive.
- Nessun dato di un'impresa deve essere leggibile o modificabile da un'altra.
- Non si deve distribuire il multi-tenant finché tutte le query e le rotte gestionali non applicano il contesto aziendale.
- Prima di ogni migrazione sul database reale: backup verificato e procedura di ripristino provata su una copia.

## Modello dati proposto

### Nuove entità

1. `companies`
   - UUID, ragione sociale, partita IVA, indirizzo e recapiti
   - stato (active, suspended), piano, date di creazione/aggiornamento
   - partita IVA normalizzata e univoca secondo la regola commerciale da definire

2. `company_memberships`
   - company_id, user_id, ruolo, stato, created_at
   - vincolo univoco (company_id, user_id)
   - un utente può appartenere a una o più aziende solo se la UX di selezione azienda è esplicita e sicura

3. Inviti aziendali (fase successiva)
   - invito con token memorizzato solo come hash, scadenza, ruolo assegnato e uso singolo

### Dati gestionali da associare a un'azienda

Aggiungere `company_id UUID NOT NULL` con FK e indice almeno a:
- customers
- funeral_cases
- staff
- vehicles
- inventory_items
- stock_movements
- tasks
- invoices
- payments

Valutare separatamente le tabelle di marketplace (`providers`, `provider_services`, `price_lists`, `provider_applications`, `inquiries`): non vanno assegnate automaticamente a una singola impresa senza una decisione funzionale.

Le relazioni tra record devono essere validate anche rispetto allo stesso `company_id`: ad esempio una fattura non deve poter collegare il cliente o la pratica di un'altra azienda.

## Autenticazione e autorizzazione

- Mantenere l'autenticazione nominativa, hash password scrypt, cookie HttpOnly/Secure/SameSite e MFA TOTP già presenti.
- Il login deve determinare le aziende alle quali l'utente appartiene; se ne ha più di una, deve selezionarne una in modo esplicito.
- Il server ricava il tenant attivo da una sessione/membership verificata, mai da un company_id liberamente inviato dal browser.
- Ogni endpoint gestionale deve applicare sia il controllo ruolo sia il filtro company_id.
- Le rotte admin globali e quelle del singolo tenant devono essere distinte.
- Valutare PostgreSQL Row Level Security come ulteriore difesa, con test che dimostrino che la connessione applicativa non può aggirare il tenant scope.

## Strategia di migrazione senza perdita dati

1. Fare backup PostgreSQL e verificarne il ripristino su database separato.
2. Creare le nuove tabelle e colonne inizialmente nullable, senza rimuovere o riscrivere dati.
3. Creare una prima azienda proprietaria per l'installazione esistente.
4. Associare tutti i record gestionali esistenti a quella sola azienda, dopo conteggi e controlli di integrità.
5. Verificare che nessun record sia rimasto senza tenant e che tutte le FK collegate appartengano alla stessa azienda.
6. Solo dopo i controlli, rendere company_id NOT NULL e aggiungere gli indici/vincoli.
7. Distribuire il codice tenant-aware in una release separata e mantenere un piano di rollback.
8. Abilitare la creazione di ulteriori aziende solo dopo il collaudo end-to-end.

La migrazione deve essere transazionale quando possibile, idempotente e registrata in schema_migrations. Le operazioni di backfill devono riportare conteggi prima/dopo e interrompersi se le verifiche non coincidono.

## Test obbligatori prima del rilascio

- Azienda A non può leggere, modificare, cancellare o collegare record dell'azienda B.
- Un utente rimosso da una membership perde immediatamente l'accesso a quell'azienda.
- Ruoli admin, manager, operator, warehouse e accounting rispettano i limiti per azienda.
- Ricerca, elenchi, dashboard, esportazioni, documenti, fatture, pagamenti e movimenti magazzino sono tenant-scoped.
- Test IDOR: sostituire UUID di clienti, pratiche, fatture e allegati con UUID di un altro tenant.
- Test concorrenti e test di regressione sull'installazione singola attuale.
- Backup e restore provati prima e dopo la migrazione.

## Sequenza di implementazione

A. Specifica e inventario di tutte le query/rotte (nessuna modifica dati).
B. Migrazione SQL additiva e testata su copia del database.
C. Middleware tenant context e membership.
D. Aggiornamento di tutte le query e validazione delle relazioni.
E. Interfaccia selezione azienda, profilo aziendale e inviti.
F. Test di isolamento, sicurezza, backup/restore e regressione.
G. Pull request e revisione; merge e deploy solo dopo approvazione e collaudo.

## Decisioni commerciali ancora da definire

- Un account può appartenere a più imprese?
- Il piano è per azienda, per utente o per numero di sedi?
- Chi può creare una nuova azienda: self-service o approvazione dell'amministratore piattaforma?
- Quali limiti e funzioni differenziano i piani?

Nessuna di queste decisioni viene presunta da questa specifica.
