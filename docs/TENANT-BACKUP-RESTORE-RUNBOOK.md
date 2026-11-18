# Funeral Smart — procedura di restore e prova multi-azienda

**Solo ambiente isolato.** Questo documento non autorizza operazioni su Render, database live, merge o deploy.

## 1. Conservare il backup originale

- Conservare il dump originale e la copia cifrata separatamente.
- Lavorare su una copia locale del dump, mai sull'unico originale.
- Non caricare il dump, dati personali, password, cookie o segreti su GitHub.
- Verificare che il file sia un archivio PostgreSQL valido con `pg_restore --list`.

## 2. Creare un database di prova nuovo

Esempio per una macchina locale con PostgreSQL:

```bash
createdb funeral_smart_tenant_rehearsal
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname=funeral_smart_tenant_rehearsal /percorso/backup.dump
```

Non usare un URL Render o un hostname remoto. Il restore va eseguito in un database vuoto e separato.

## 3. Fotografia iniziale

Prima di applicare le bozze, registrare i conteggi delle nove tabelle gestionali:

- customers
- funeral_cases
- staff
- vehicles
- inventory_items
- stock_movements
- tasks
- invoices
- payments

Registrare inoltre il numero di utenti attivi per ruolo, le relazioni esistenti e gli eventuali record orfani. Non includere nomi, recapiti o dati dei defunti nel report condiviso.

## 4. Preparazione schema tenant

Sul clone locale, applicare in sequenza le migrazioni 005–011 con transazione per file. Non eseguire la 012 in questa fase.

Dopo 005–011, eseguire lo script read-only:

```bash
NODE_ENV=test DATABASE_URL=postgres://localhost/funeral_smart_tenant_rehearsal \
  node scripts/tenant-backfill-preflight.js
```

Il report deve essere conservato insieme ai conteggi iniziali. Le colonne `company_id` sono ancora nullable in questa fase.

## 5. Mappatura esplicita e backfill per una sola impresa

La proprietà dei dati legacy è stata indicata come una sola impresa. Sul clone ripristinato:
- creare/verificare una sola riga in `companies`, usando denominazione legale e dati aziendali corretti; il backfill non inventa la denominazione né la partita IVA;
- verificare che tutti i dati gestionali storici appartengano a quella stessa impresa;
- mantenere i ruoli legacy riconosciuti (`admin`, `manager`, `operator`, `warehouse`, `accounting`) e creare una membership per ciascun account; gli account inattivi ricevono membership sospesa;
- gli account `platform_owner` restano separati e non ricevono membership aziendale;
- collegare le sessioni esistenti alla membership dello stesso utente;
- lasciare invariati gli eventi storici di audit, che possono rimanere senza contesto aziendale.

Lo script `scripts/backfill-single-company.js` è **dry-run per impostazione predefinita**. Funziona solo su PostgreSQL locale, richiede un `COMPANY_ID` esistente e verifica che esista esattamente una sola azienda. Per il dry-run:

```bash
NODE_ENV=test DATABASE_URL=postgres://localhost/funeral_smart_tenant_rehearsal \
  COMPANY_ID=UUID_AZIENDA node scripts/backfill-single-company.js --dry-run
```

Solo dopo aver esaminato il report, su un clone usa-e-getta, il backfill può essere provato con `--apply` e `CONFIRM_SINGLE_COMPANY_BACKFILL=YES`. Non usare mai un URL Render o un database remoto. L'operazione è transazionale e verifica i risultati prima del commit.

## 6. Verifica e finalizzazione

Dopo il backfill:
1. ripetere il preflight e verificare zero righe senza azienda;
2. verificare zero relazioni cross-company;
3. verificare le 8 FK composte e le 9 FK verso `companies`;
4. verificare la membership attiva di ogni utente aziendale;
5. applicare la bozza 012 soltanto sul clone;
6. verificare `company_id NOT NULL` sulle nove tabelle e i quattro indici unici per azienda;
7. eseguire i test PostgreSQL Alfa/Beta e la suite applicativa;
8. provare il rollback ripristinando il dump originale in un secondo database nuovo.

La migrazione 012 rimuove i vincoli globali su codice pratica, targa, SKU e numero fattura soltanto dopo la creazione e verifica dei corrispondenti indici unici per azienda.

## 7. Criterio di arresto

Se i conteggi non coincidono, una relazione è ambigua, manca una membership, un indice o una FK non è validata, fermarsi e non abilitare il multi-tenant. Nessuna variabile Render deve essere modificata in questa fase.

## 8. Evidenze del backup cifrato e restore test

**Backup originale del 12 novembre 2026; verifica documentale e hash ripetuta il 18 novembre 2026.**

### Integrità dei file

- File cifrato: `funeral-smart-20261112-175532.dump.enc`, 48.688 byte. L'intestazione è `Salted__`, coerente con il formato OpenSSL salted.
- SHA-256 del file cifrato: `ad7ef7f9e77be89e37464205778972502ee125fd886d8c0e826bf7ec7eabe81c`.
- Sono state confrontate tre copie archiviate del file cifrato: dimensione e SHA-256 coincidono.
- File dump decifrato: formato PostgreSQL Custom, intestazione `PGDMP`, 48.665 byte.
- SHA-256 del dump: `d908945e14e60bf6de677677e6c7a374fd2eb8ee0cf13c9e95af0a9d328779be`.
- Il valore SHA-256 del dump coincide con quello registrato il 13 novembre per il file decifrato di verifica e per il dump originale.

### Decrittografia e leggibilità dell'archivio

- Il 13 novembre 2026 la decrittografia è stata completata con esito positivo usando OpenSSL AES-256-CBC, PBKDF2 e 200.000 iterazioni (`openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000`). La passphrase è rimasta privata e non è riportata qui.
- Nella stessa sessione, il dump decifrato ha superato `pg_restore --list`: formato CUSTOM, 111 voci TOC, compressione gzip, database sorgente `funeral_smart`, PostgreSQL sorgente 18.6 e pg_dump 18.2.
- L'elenco includeva 20 tabelle pubbliche, dati, indici, vincoli e la sequenza `audit_log_id_seq`.

### Ripristino isolato

- Il 13 novembre 2026 il dump è stato ripristinato nel database temporaneo locale `funeral_test`, su `127.0.0.1:5432`, con:
  `pg_restore --verbose --exit-on-error --no-owner --no-privileges -h 127.0.0.1 -p 5432 -d funeral_test`.
- L'output riportato dall'utente è arrivato alla creazione dei vincoli FK senza errori; il successivo conteggio ha restituito 20 tabelle.
- Nessuna operazione è stata eseguita sul database di produzione o su Render.
- La verifica del 18 novembre ha ricalcolato gli hash dei file archiviati e ha confermato l'intestazione OpenSSL, il formato Custom del dump e l'identità delle tre copie cifrate. La decrittografia non è stata ripetuta in questa sessione perché la passphrase non viene trasferita o condivisa.

### Limiti residui

Il test di restore locale e la corrispondenza SHA-256 del dump decifrato sono documentati. Non sono invece conservati report completi con conteggi riga per riga di tutte le tabelle, confronto con una fotografia del database sorgente, verifica esplicita dei valori delle sequenze o un report separato di tutti i controlli referenziali. Questi controlli restano necessari per una prova di integrità dei dati più completa.

Per un prossimo controllo ripetibile:
1. Conservare intatti i file originali e lavorare su copie locali.
2. Ricalcolare SHA-256 prima e dopo ogni copia; registrare separatamente hash del cifrato e del dump decifrato.
3. Decifrare una copia localmente con i parametri verificati; fornire la passphrase soltanto al prompt/strumento locale, mai in chat o in GitHub.
4. Verificare il dump con `pg_restore --list`; in caso di errore fermarsi senza tentare un restore parziale.
5. Ripristinare in un database PostgreSQL locale, vuoto e usa-e-getta.
6. Confrontare conteggi di tutte le tabelle, sequenze e integrità referenziale con una fotografia di riferimento, senza esportare dati personali.
7. Registrare soltanto esito, data, versione dello schema, conteggi aggregati e hash. Non condividere dump, dati personali, chiavi o passphrase.

## 9. Limiti del collaudo automatico e attività ancora aperte

- I workflow GitHub su PostgreSQL usa-e-getta verificano schema, migrazioni draft, isolamento Alfa/Beta, bootstrap e API. **Non sostituiscono** il restore test del backup effettivo, che è stato eseguito localmente come descritto sopra.
- La documentazione del repository indica ancora come attività da realizzare i backup automatici, la retention e i test periodici di ripristino. Non considerare quindi già disponibile un servizio automatico completo solo perché il database è ospitato su Render.
- Restano da produrre evidenze ripetibili sui conteggi riga per riga, sulle sequenze e sul confronto completo dei dati del dump ripristinato.
- Nessun test descritto in questa procedura autorizza l'uso del database di produzione, la modifica di Render, l'attivazione di flag tenant, il merge o il deploy.
