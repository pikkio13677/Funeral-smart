# FUNERAL SMART — Piano test multi-tenant

## Stato attuale
Il package usa Node.js >=20 e non dichiara attualmente un framework di test. È possibile iniziare con il modulo nativo `node:test` e `node:assert/strict`, senza introdurre dipendenze di produzione. I test d'integrazione richiederanno un database PostgreSQL isolato e variabili d'ambiente di test dedicate.

## Ambienti
- Unit test: nessuna connessione al database di produzione.
- Integration test: database PostgreSQL effimero o database dedicato ricreato per ogni suite.
- E2E: servizio avviato con configurazione di test, mai con il DATABASE_URL di Render.
- Dati sintetici: aziende Alfa e Beta, utenti distinti, identificativi UUID generati dal test.

## Matrice di test obbligatoria

| Caso | Attore | Operazione | Risultato atteso |
|---|---|---|---|
| T01 | utente Alfa | elenco clienti | solo clienti Alfa |
| T02 | utente Alfa | GET pratica Beta tramite UUID noto | 404, nessun dato |
| T03 | utente Alfa | PATCH stato pratica Beta | 404, nessuna modifica |
| T04 | operatore Alfa | gestione membri | 403 |
| T05 | admin Alfa | gestione membri Beta | 404/403, nessun dato |
| T06 | membership sospesa | richiesta gestionale | 403 |
| T07 | membership revocata | richiesta con sessione già valida | 403 immediato |
| T08 | utente multi-azienda | seleziona Beta senza membership | 403 |
| T09 | utente multi-azienda | seleziona Beta con membership attiva | contesto Beta verificato |
| T10 | Alfa | crea pratica collegata a cliente Beta | rifiuto transazione |
| T11 | Alfa | crea task assegnato a staff Beta | rifiuto transazione |
| T12 | Alfa | movimento su articolo Beta | 404/403 e quantità invariata |
| T13 | Alfa | registra pagamento su fattura Beta | 404/403 e saldo invariato |
| T14 | Alfa | dashboard e conteggi | nessun conteggio Beta |
| T15 | admin Alfa | legge audit | solo audit Alfa |
| T16 | piattaforma-admin | legge audit piattaforma | solo eventi autorizzati e auditati |
| T17 | richieste concorrenti | cambio azienda/sessione | nessun riuso del contesto tra richieste |
| T18 | regressione MFA | login + TOTP | invariato |
| T19 | regressione sessione | cookie scaduto/logout | accesso negato |
| T20 | legacy single-tenant | dati storici | visibilità invariata nell'azienda iniziale |

## Test d'integrità SQL

Creare dati di Alfa e Beta e provare direttamente:
- FK composta che impedisce case/customer cross-tenant;
- FK composta che impedisce invoice/case/customer cross-tenant;
- FK composta che impedisce payment/invoice cross-tenant;
- FK composta che impedisce stock movement/item/case cross-tenant;
- FK composta che impedisce task/case/staff cross-tenant;
- unicità di case_code, plate, sku e invoice_number entro azienda, con possibilità di riutilizzo tra aziende solo se la decisione di prodotto è confermata.

Ogni test di scrittura deve controllare anche che il database sia rimasto invariato dopo il rifiuto.

## Criterio di rilascio
Nessuna PR multi-tenant va dichiarata pronta per produzione finché tutti i test sopra non passano in CI e su un database ripristinato da backup. Un test manuale con un solo account o una sola azienda non dimostra l'isolamento.
